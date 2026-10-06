require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.static('public'));
app.use(express.json({ limit: '5mb' }));

function getCreds() {
  if (process.env.VCAP_SERVICES) {
    const vcap = JSON.parse(process.env.VCAP_SERVICES);
    const svc = vcap['document-information-extraction-trial'][0].credentials;
    return { uaaUrl: svc.uaa.url, clientId: svc.uaa.clientid, clientSecret: svc.uaa.clientsecret, apiUrl: svc.url };
  }
  return { uaaUrl: process.env.UAA_URL, clientId: process.env.CLIENT_ID, clientSecret: process.env.CLIENT_SECRET, apiUrl: process.env.DOCAI_URL };
}

async function getToken() {
  const c = getCreds();
  const res = await axios.post(`${c.uaaUrl}/oauth/token`,
    new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return res.data.access_token;
}

app.post('/extract', upload.single('file'), async (req, res) => {
  try {
    const c = getCreds();
    const token = await getToken();
    const form = new FormData();
    form.append('file', req.file.buffer, req.file.originalname);
    form.append('options', JSON.stringify({ schemaName: 'SAP_invoice_schema', clientId: 'default', documentType: 'invoice' }));

    const submitRes = await axios.post(`${c.apiUrl}/document-information-extraction/v1/document/jobs`, form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` } });
    const jobId = submitRes.data.id;

    let result;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const statusRes = await axios.get(`${c.apiUrl}/document-information-extraction/v1/document/jobs/${jobId}`,
        { headers: { Authorization: `Bearer ${token}` } });
      if (statusRes.data.status === 'DONE') { result = statusRes.data; break; }
      if (statusRes.data.status === 'FAILED') return res.status(500).json(statusRes.data);
    }
    if (!result) return res.status(202).json({ message: 'Still processing, try again shortly.' });
    res.json(result);
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.response ? err.response.data : err.message });
  }
});

// ---------- S/4HANA posting (Non-PO supplier invoice) ----------
const S4 = {
  destination: process.env.S4_DESTINATION || 'meil',
  client: process.env.S4_CLIENT || '300',
  service: '/sap/opu/odata/sap/API_SUPPLIERINVOICE_PROCESS_SRV'
};

// Controlled accounting rules (POC). Move to config/master data later.
const RULES = {
  companyCode: '3120',
  glAccount: '40005050',
  costCenter: '312000002',   // per design doc; earlier test payload used 3120000002 - confirm in S/4
  taxCode: '94',
  vendors: { 'THERMAX LIMITED PUNE': '10527890' }
};

const getField = (hf, name) => (hf.find(x => x.name === name) || {}).value;

function toSapDate(v) {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.substring(0, 10) + 'T00:00:00';
  const d = new Date(v);
  if (isNaN(d)) return null;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00`;
}

function buildPayload(docAi) {
  const hf = (docAi.extraction && docAi.extraction.headerFields) || [];
  const invNo = getField(hf, 'documentNumber');
  const date = toSapDate(getField(hf, 'documentDate'));
  const supplier = String(getField(hf, 'senderName') || '').toUpperCase().trim();
  const cur = getField(hf, 'currencyCode') || 'INR';
  const gross = Number(getField(hf, 'grossAmount'));
  const tax = Number(getField(hf, 'taxAmount') || 0);
  let net = getField(hf, 'netAmount');
  net = net !== undefined ? Number(net) : gross - tax;

  const errors = [];
  if (!invNo) errors.push('Invoice number missing');
  if (!date) errors.push('Invoice date missing/invalid');
  if (!gross) errors.push('Gross amount missing');
 const vendorKey = Object.keys(RULES.vendors).find(k => supplier.includes(k));
const vendor = vendorKey ? RULES.vendors[vendorKey] : undefined;
  if (!vendor) errors.push(`Supplier "${supplier}" not matched to an S/4 supplier - manual review`);
  if (Math.abs(net + tax - gross) > 0.02) errors.push('Gross does not equal taxable + tax');
  if (errors.length) { const e = new Error(errors.join('; ')); e.validation = errors; throw e; }

  return {
    CompanyCode: RULES.companyCode,
    DocumentDate: date,
    PostingDate: date,
    SupplierInvoiceIDByInvcgParty: String(invNo),
    InvoicingParty: vendor,
    DocumentCurrency: cur,
    InvoiceGrossAmount: gross.toFixed(2),
    TaxIsCalculatedAutomatically: true,
    to_SupplierInvoiceItemGLAcct: [{
      SupplierInvoiceItem: '1',
      CompanyCode: RULES.companyCode,
      GLAccount: RULES.glAccount,
      CostCenter: RULES.costCenter,
      TaxCode: RULES.taxCode,
      DocumentCurrency: cur,
      SupplierInvoiceItemAmount: net.toFixed(2),
      DebitCreditCode: 'S'
    }]
  };
}

// Step 1: build + validate, return payload for review (no S/4 call)
app.post('/preview-invoice', (req, res) => {
  try {
    res.json({ ok: true, payload: buildPayload(req.body.docAi) });
  } catch (e) {
    res.status(422).json({ ok: false, errors: e.validation || [e.message] });
  }
});

// Step 2: user approved -> post to S/4
app.post('/post-invoice', async (req, res) => {
  try {
    const payload = req.body.payload || buildPayload(req.body.docAi);
    const r = await executeHttpRequest(
      { destinationName: S4.destination },
      {
        method: 'POST',
        url: `${S4.service}/A_SupplierInvoice`,
        params: { 'sap-client': S4.client },
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        data: payload
      },
      { fetchCsrfToken: true }
    );
    const d = (r.data && r.data.d) || r.data;
    res.json({ ok: true, supplierInvoice: d.SupplierInvoice, fiscalYear: d.FiscalYear, payload });
  } catch (e) {
    console.error(e.response ? JSON.stringify(e.response.data) : e.message);
    const msg = e.validation ? e.validation.join('; ')
      : (e.response && e.response.data && e.response.data.error && e.response.data.error.message && e.response.data.error.message.value) || e.message;
    res.status(e.validation ? 422 : (e.response ? e.response.status : 500)).json({ ok: false, error: msg });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));