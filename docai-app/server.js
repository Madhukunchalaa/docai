require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.static('public'));

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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
