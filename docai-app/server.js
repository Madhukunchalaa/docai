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

// Fallback defaults (POC). Used ONLY when the value cannot be read from the invoice or S/4:
//  - G/L account & cost center for Non-PO invoices (accounting decision, not printed on invoices)
//  - supplier list if the S/4 supplier search is not available
// Everything else is taken from Document AI / the PO in S/4.
const RULES = {
  companyCode: '3120',
  glAccount: '40005050',
  documentType: 'KR',
  costCenter: '3120000002',
  taxCode: '94',
  vendors: { 'THERMAX LIMITED PUNE': '10527890', 'RAVI CONSTRUCTION': '10527885' }
};
// tax rate printed on the invoice (Document AI 'taxRate') -> S/4 tax code
const TAX_CODES = { 18: '94' };

const getField = (hf, name) => (hf.find(x => x.name === name) || {}).value;

function toSapDate(v) {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.substring(0, 10) + 'T00:00:00';
  const d = new Date(v);
  if (isNaN(d)) return null;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00`;
}

// ---------- PO lookup: read supplier / items / GR from S/4 by PO number ----------
const S4_PO = '/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV';
const S4_MD = '/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV';

async function s4Get(url, params) {
  const r = await executeHttpRequest(
    { destinationName: S4.destination },
    { method: 'GET', url, params: { 'sap-client': S4.client, '$format': 'json', ...params }, headers: { Accept: 'application/json' } }
  );
  return r.data;
}
const normItem = v => String(parseInt(v, 10));
const rowsOf = d => { const x = (d && d.d) || d || {}; return x.results || (Array.isArray(x) ? x : []); };

async function lookupPO(poNumber) {
  const po = String(poNumber).trim().padStart(10, '0');
  const hdr = await s4Get(`${S4_PO}/A_PurchaseOrder('${po}')`, { '$expand': 'to_PurchaseOrderItem' });
  const h = (hdr && hdr.d) || hdr;
  const items = rowsOf({ d: h.to_PurchaseOrderItem }).map(i => ({
    item: i.PurchaseOrderItem,
    orderQty: Number(i.OrderQuantity),
    unit: i.PurchaseOrderQuantityUnit,
    netPrice: Number(i.NetPriceAmount),
    per: Number(i.NetPriceQuantity || 1),
    taxCode: i.TaxCode || '',
    grs: []
  }));
  // goods receipts (movement type 101) for this PO
  let grError = null, grRows = 0;
  try {
    const md = await s4Get(`${S4_MD}/A_MaterialDocumentItem`, {
      '$filter': `PurchaseOrder eq '${po}' and GoodsMovementType eq '101'`,
      '$select': 'MaterialDocument,MaterialDocumentYear,MaterialDocumentItem,PurchaseOrderItem,QuantityInEntryUnit,GoodsMovementType'
    });
    rowsOf(md).forEach(g => {
      grRows++;
      const it = items.find(x => normItem(x.item) === normItem(g.PurchaseOrderItem));
      if (it) it.grs.push({ doc: g.MaterialDocument, year: g.MaterialDocumentYear, item: g.MaterialDocumentItem, qty: Number(g.QuantityInEntryUnit) });
    });
  } catch (e) {
    grError = (e.response ? e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 300) : e.message);
    console.error('GR lookup failed:', grError);
  }
  return { po, supplier: h.Supplier, companyCode: h.CompanyCode, items, grRows, grError };
}

// Find the S/4 supplier number from the supplier name read by Document AI
async function findSupplier(rawName) {
  let n = String(rawName || '').trim();
  const half = Math.floor(n.length / 2);                       // Document AI sometimes returns the name twice
  if (n.length > 6 && n.slice(0, half).trim() === n.slice(half).trim()) n = n.slice(0, half).trim();
  if (!n) return null;
  const safe = n.toLowerCase().replace(/'/g, "''");
  const d = await s4Get('/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_Supplier',
    { '$filter': `substringof('${safe}',tolower(SupplierName))`, '$select': 'Supplier,SupplierName', '$top': '5' });
  const rows = rowsOf(d);
  const exact = rows.find(r => String(r.SupplierName).toLowerCase() === n.toLowerCase());
  const hit = exact || (rows.length === 1 ? rows[0] : null);
  return hit ? { supplier: hit.Supplier, name: hit.SupplierName } : null;
}

function pickFromPO(lookup, po, net) {
  const info = [];
  let it = po.item ? lookup.items.find(x => normItem(x.item) === normItem(po.item)) : null;
  const unitPrice = x => x.netPrice / (x.per || 1);
  if (!it) {
    // auto-select: first item with a goods receipt that covers net / price
    const cand = lookup.items.filter(x => x.grs.length);
    it = cand.find(x => { const q = net / unitPrice(x); return x.grs.reduce((a, g) => a + g.qty, 0) + 0.0005 >= q; }) || cand[0];
    if (!it && po.refDoc) it = lookup.items.find(x => net / unitPrice(x) <= x.orderQty + 0.0005) || lookup.items[0];   // GR typed by user
    if (!it) throw Object.assign(new Error('x'), { validation: [`No goods receipt found for PO ${lookup.po} - post a GR first, or check PO number`] });
  }
  const qty = po.qty ? Number(po.qty) : Math.round((net / unitPrice(it)) * 1000) / 1000;
  const gr = (po.refDoc ? { doc: po.refDoc, year: po.refYear || '2026', item: po.refItem || '1' }
    : it.grs.find(g => g.qty + 0.0005 >= qty) || it.grs[0]);
  info.push(`PO ${lookup.po}: supplier ${lookup.supplier}, item ${it.item}, ${qty} ${it.unit} @ ${it.netPrice}`);
  if (gr) info.push(`Goods receipt ${gr.doc} / ${gr.year} / ${gr.item}`);
  return { it, qty, gr, info };
}

function buildPayload(docAi, mode, po, lookup, vendorHit) {
  mode = mode === 'PO' ? 'PO' : 'NONPO';
  po = po || {};
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
  const usePo = mode === 'PO' && lookup;
  const vKey = Object.keys(RULES.vendors).find(k => supplier.includes(k.toUpperCase()));
  // PO invoices: supplier comes from the PO in S/4. Non-PO: controlled list (POC).
  const vendor = usePo ? lookup.supplier : ((vendorHit && vendorHit.supplier) || (vKey ? RULES.vendors[vKey] : undefined));
  if (!vendor) errors.push(`Supplier "${supplier}" not matched to an S/4 supplier - manual review`);
  if (Math.abs(net + tax - gross) > 0.02) errors.push('Gross does not equal taxable + tax');
  const poNumber = String(po.number || getField(hf, 'purchaseOrderNumber') || '').trim();
  const poItem = String(po.item || '').trim();
  if (mode === 'PO') {
    if (!poNumber) errors.push('PO number missing - enter it or choose Non-PO');
    if (po.item && !/^\d{1,5}$/.test(poItem)) errors.push('PO item must be numeric (e.g. 10)');
  }
  if (errors.length) { const e = new Error(errors.join('; ')); e.validation = errors; throw e; }

  const taxRate = Number(getField(hf, 'taxRate'));
  const taxCode = TAX_CODES[taxRate] || RULES.taxCode;
  const companyCode = (usePo && lookup.companyCode) || RULES.companyCode;

  const header = {
    CompanyCode: companyCode,
    DocumentDate: date,
    PostingDate: date,
    DueCalculationBaseDate: date,
    SupplierInvoiceIDByInvcgParty: String(invNo),
    InvoicingParty: vendor,
    DocumentCurrency: cur,
    InvoiceGrossAmount: gross.toFixed(2),
    TaxIsCalculatedAutomatically: true
  };

  if (mode === 'PO') {
    const poItemObj = {
      SupplierInvoiceItem: '1',
      PurchaseOrder: poNumber,
      DocumentCurrency: cur,
      SupplierInvoiceItemAmount: net.toFixed(2),
      TaxCode: taxCode
    };
    let info = [];
    if (lookup) {
      const pk = pickFromPO(lookup, po, net);
      info = pk.info;
      poItemObj.PurchaseOrder = lookup.po;
      poItemObj.PurchaseOrderItem = String(pk.it.item);
      poItemObj.QuantityInPurchaseOrderUnit = String(pk.qty);
      if (pk.it.unit) poItemObj.PurchaseOrderQuantityUnit = String(po.unit || pk.it.unit);   // unit as shown by S/4 for the PO item (e.g. 'Nos')
      if (pk.it.taxCode) poItemObj.TaxCode = pk.it.taxCode;
      if (pk.gr) {
        poItemObj.ReferenceDocument = String(pk.gr.doc);
        poItemObj.ReferenceDocumentFiscalYear = String(pk.gr.year);
        poItemObj.ReferenceDocumentItem = String(pk.gr.item);
      }
    } else {
      // PO lookup unavailable: use values typed on the screen
      poItemObj.PurchaseOrderItem = poItem || '10';
      if (po.qty) poItemObj.QuantityInPurchaseOrderUnit = String(po.qty);
      if (po.unit) poItemObj.PurchaseOrderQuantityUnit = String(po.unit);
      if (po.refDoc) {
        poItemObj.ReferenceDocument = String(po.refDoc);
        poItemObj.ReferenceDocumentFiscalYear = String(po.refYear || '2026');
        poItemObj.ReferenceDocumentItem = String(po.refItem || '1');
      }
    }
    buildPayload.lastInfo = info;
    return { ...header, to_SuplrInvcItemPurOrdRef: [poItemObj] };
  }
  return {
    ...header,
    AccountingDocumentType: RULES.documentType,
    to_SupplierInvoiceItemGLAcct: [{
      SupplierInvoiceItem: '1',
      CompanyCode: companyCode,
      GLAccount: RULES.glAccount,
      CostCenter: RULES.costCenter,
      TaxCode: taxCode,
      DocumentCurrency: cur,
      SupplierInvoiceItemAmount: net.toFixed(2),
      DebitCreditCode: 'S'
    }]
  };
}

// Step 1: build + validate, return payload for review (no S/4 call)
app.post('/preview-invoice', async (req, res) => {
  try {
    const { docAi, mode, po } = req.body;
    let lookup = null, note = null;
    if (mode === 'PO') {
      const hf = (docAi.extraction && docAi.extraction.headerFields) || [];
      const poNo = String((po && po.number) || getField(hf, 'purchaseOrderNumber') || '').trim();
      if (poNo) {
        try { lookup = await lookupPO(poNo); }
        catch (e) {
          console.error('PO lookup failed:', e.response ? JSON.stringify(e.response.data) : e.message);
          note = 'PO lookup in S/4 not available (' + ((e.response && e.response.status) || e.message) + ') - using values typed on screen';
        }
      }
    }
    let vendorHit = null;
    if (!lookup) {
      const hf2 = (docAi.extraction && docAi.extraction.headerFields) || [];
      try { vendorHit = await findSupplier(getField(hf2, 'senderName')); }
      catch (e) { console.error('Supplier search failed:', e.response ? JSON.stringify(e.response.data) : e.message); }
    }
    buildPayload.lastInfo = [];
    const payload = buildPayload(docAi, mode, po, lookup, vendorHit);
    const info = (note ? [note] : buildPayload.lastInfo).slice();
    if (lookup && lookup.grError) info.push('Goods receipt lookup failed: ' + lookup.grError);
    if (vendorHit) info.push(`Supplier ${vendorHit.supplier} (${vendorHit.name}) found in S/4`);
    res.json({ ok: true, payload, info });
  } catch (e) {
    res.status(422).json({ ok: false, errors: e.validation || [e.message] });
  }
});

// Standalone PO lookup (for testing): GET /po-lookup?po=4100131815
app.get('/po-lookup', async (req, res) => {
  try { res.json({ ok: true, ...(await lookupPO(req.query.po)) }); }
  catch (e) { res.status(e.response ? e.response.status : 500).json({ ok: false, error: e.response ? e.response.data : e.message }); }
});

// Diagnostic: raw goods-receipt query result  GET /gr-lookup?po=4100131815
app.get('/gr-lookup', async (req, res) => {
  try {
    const po = String(req.query.po).trim().padStart(10, '0');
    const d = await s4Get(`${S4_MD}/A_MaterialDocumentItem`, {
      '$filter': `PurchaseOrder eq '${po}'`, '$top': '20',
      '$select': 'MaterialDocument,MaterialDocumentYear,MaterialDocumentItem,PurchaseOrder,PurchaseOrderItem,GoodsMovementType,QuantityInEntryUnit'
    });
    res.json({ ok: true, rows: rowsOf(d) });
  } catch (e) { res.status(e.response ? e.response.status : 500).json({ ok: false, error: e.response ? e.response.data : e.message }); }
});

// Step 2: user approved -> post to S/4
app.post('/post-invoice', async (req, res) => {
  try {
    const payload = req.body.payload || buildPayload(req.body.docAi, req.body.mode, req.body.po);
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