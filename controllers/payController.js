const axios = require('axios');
const { db } = require('../config/firebase');
const { doc, getDoc, setDoc, collection, query, where, getDocs } = require('firebase/firestore');
const settingsService = require('../services/settingsService');

const DARAJA_BASE_URL = 'https://api.safaricom.co.ke';
const MASTER_SHORTCODE = process.env.KODIPAY_MASTER_SHORTCODE || '4005473';
const MASTER_PASSKEY   = process.env.KODIPAY_MASTER_PASSKEY   || '';
const MASTER_KEY       = process.env.KODIPAY_MASTER_CONSUMER_KEY || '';
const MASTER_SECRET    = process.env.KODIPAY_MASTER_CONSUMER_SECRET || '';

const BACKEND_URL = (process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'https://rent-manager-server.onrender.com').replace(/\/$/, '');

// ─── helpers ───────────────────────────────────────────────────────────────
function getTimestamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join('');
}

function formatPhone(phone) {
  let p = phone.trim().replace(/\+/g, '');
  if (p.startsWith('0'))  p = '254' + p.substring(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return p;
}

async function getMasterToken() {
  const auth = Buffer.from(`${MASTER_KEY}:${MASTER_SECRET}`).toString('base64');
  const r = await axios.get(`${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  return r.data.access_token;
}

// ─── GET /pay/:tenantId  (serves the checkout HTML page) ───────────────────
async function checkoutPage(req, res) {
  try {
    const { tenantId } = req.params;
    const tenantRef  = doc(db, 'tenants', tenantId);
    const tenantSnap = await getDoc(tenantRef);

    if (!tenantSnap.exists()) {
      return res.status(404).send('<h2 style="font-family:sans-serif;text-align:center;margin-top:80px">Tenant not found</h2>');
    }

    const tenant   = tenantSnap.data();
    const agencyId = tenant.agencyId || 'app-settings';
    const settings = await settingsService.getSettings(agencyId);

    // property name
    let propertyName = '';
    if (tenant.propertyId) {
      const propSnap = await getDoc(doc(db, 'properties', tenant.propertyId));
      if (propSnap.exists()) propertyName = propSnap.data().name || '';
    }

    let rent = 0, deposit = 0, garbage = 0, water = 0, electricity = 0, penalties = 0;
    
    // Get breakdown
    penalties = tenant.penaltyApplied ? (parseFloat(tenant.penaltyAmount) || 0) : 0;
    if (tenant.unitCode && tenant.agencyId) {
      const unitsQuery = query(collection(db, 'units'), where('unitId', '==', tenant.unitCode), where('agencyId', '==', tenant.agencyId));
      const unitsSnap = await getDocs(unitsQuery);
      if (!unitsSnap.empty) {
        const unit = unitsSnap.docs[0].data();
        rent = parseFloat(unit.rentAmount || unit.rent) || 0;
        garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
        water = parseFloat(unit.utilityFees?.waterBill) || 0;
        electricity = parseFloat(unit.utilityFees?.electricityBill) || 0;
        const { isMovedInThisMonth } = require('../utils/dateHelper');
        if (isMovedInThisMonth(tenant.moveInDate)) {
           deposit = parseFloat(unit.depositAmount || unit.deposit) || 0;
        }
      }
    }
    const tracking = tenant.monthlyPaymentTracking || {};
    if (tracking.breakdown) {
       if (tracking.breakdown.rent) rent = parseFloat(tracking.breakdown.rent) || rent;
       if (tracking.breakdown.deposit) deposit = parseFloat(tracking.breakdown.deposit) || deposit;
       if (tracking.breakdown.garbageFee) garbage = parseFloat(tracking.breakdown.garbageFee) || garbage;
       if (tracking.breakdown.garbage) garbage = parseFloat(tracking.breakdown.garbage) || garbage;
       if (tracking.breakdown.waterBill) water = parseFloat(tracking.breakdown.waterBill) || water;
       if (tracking.breakdown.water) water = parseFloat(tracking.breakdown.water) || water;
       if (tracking.breakdown.electricityBill) electricity = parseFloat(tracking.breakdown.electricityBill) || electricity;
       if (tracking.breakdown.electricity) electricity = parseFloat(tracking.breakdown.electricity) || electricity;
       if (tracking.breakdown.penalties) penalties = parseFloat(tracking.breakdown.penalties) || penalties;
    }

    const amountDue = tenant.arrears || 0;
    const breakdown = { rent, deposit, garbage, water, electricity, penalties };
    const agencyName = settings.agencyName || 'KodiPay';
    const tenantPhone = tenant.phone || '';
    const displayPhone = tenantPhone.trim().startsWith('0')
      ? tenantPhone.trim()
      : `0${tenantPhone.trim().replace(/^(\+?254)/, '')}`;

    const html = buildCheckoutHTML({
      tenantId,
      tenantName: tenant.name || 'Tenant',
      unitCode:   tenant.unitCode || '',
      propertyName,
      amountDue,
      breakdown,
      phone:      displayPhone,
      agencyName,
      backendUrl: BACKEND_URL,
    });

    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  } catch (err) {
    console.error('❌ [PayPage] Error rendering checkout:', err.message);
    res.status(500).send('<h2 style="font-family:sans-serif;text-align:center;margin-top:80px">Something went wrong. Please try again.</h2>');
  }
}

// ─── POST /api/pay/stk  (trigger STK push) ────────────────────────────────
async function initiateStk(req, res) {
  const { tenantId, phone, amount } = req.body;

  if (!tenantId || !phone || !amount) {
    return res.status(400).json({ success: false, error: 'tenantId, phone, and amount are required.' });
  }

  try {
    const token     = await getMasterToken();
    const timestamp = getTimestamp();
    const password  = Buffer.from(`${MASTER_SHORTCODE}${MASTER_PASSKEY}${timestamp}`).toString('base64');
    const fmtPhone  = formatPhone(phone);

    const payload = {
      BusinessShortCode: MASTER_SHORTCODE,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   'CustomerPayBillOnline',
      Amount:            Math.round(parseFloat(amount)),
      PartyA:            fmtPhone,
      PartyB:            MASTER_SHORTCODE,
      PhoneNumber:       fmtPhone,
      CallBackURL:       `${BACKEND_URL}/api/pay/stk-callback`,
      AccountReference:  fmtPhone,
      TransactionDesc:   'Rent Payment via KodiPay',
    };

    console.log(`📱 [PaySTK] Initiating rent STK push — KSh ${payload.Amount} to ${fmtPhone}`);

    const r = await axios.post(`${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`, payload, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const { CheckoutRequestID, ResponseCode, CustomerMessage } = r.data;

    if (ResponseCode !== '0') throw new Error('Daraja rejected the request');

    // Persist pending checkout for callback matching
    await setDoc(doc(db, 'rent_stk_checkouts', CheckoutRequestID), {
      CheckoutRequestID,
      tenantId,
      phone:     fmtPhone,
      amount:    parseFloat(amount),
      status:    'pending',
      createdAt: new Date().toISOString(),
    });

    console.log(`✅ [PaySTK] STK push accepted. CheckoutRequestID: ${CheckoutRequestID}`);
    return res.json({ success: true, checkoutRequestId: CheckoutRequestID, message: CustomerMessage });

  } catch (err) {
    const detail = err.response?.data?.errorMessage || err.message;
    console.error('❌ [PaySTK] STK push failed:', detail);
    return res.status(500).json({ success: false, error: detail });
  }
}

// ─── POST /api/pay/stk-callback  (Safaricom fires this) ───────────────────
async function stkCallback(req, res) {
  console.log('📩 [PaySTK Callback]', JSON.stringify(req.body, null, 2));
  try {
    const cb  = req.body?.Body?.stkCallback;
    const id  = cb?.CheckoutRequestID;
    const rc  = cb?.ResultCode;
    const rd  = cb?.ResultDesc;

    if (id) {
      const ref  = doc(db, 'rent_stk_checkouts', id);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const { setDoc: sd } = require('firebase/firestore');
        if (rc === 0) {
          const meta   = cb?.CallbackMetadata?.Item || [];
          const getVal = (k) => meta.find(i => i.Name === k)?.Value || '';
          const { updateDoc } = require('firebase/firestore');
          await updateDoc(ref, {
            status:    'completed',
            receiptNo: getVal('MpesaReceiptNumber'),
            paidAmount: getVal('Amount'),
            completedAt: new Date().toISOString(),
          });
          console.log(`✅ [PaySTK Callback] Payment success for checkout ${id}`);
        } else {
          const { updateDoc } = require('firebase/firestore');
          await updateDoc(ref, {
            status:   'failed',
            resultDesc: rd,
            failedAt: new Date().toISOString(),
          });
          console.warn(`⚠️ [PaySTK Callback] Payment failed for ${id}: ${rd}`);
        }
      }
    }
  } catch (err) {
    console.error('❌ [PaySTK Callback] Error:', err.message);
  }
  return res.json({ ResultCode: 0, ResultDesc: 'Received' });
}

// ─── GET /api/pay/status/:checkoutId  (frontend polls this) ───────────────
async function checkStatus(req, res) {
  try {
    const snap = await getDoc(doc(db, 'rent_stk_checkouts', req.params.checkoutId));
    if (!snap.exists()) return res.status(404).json({ success: false, error: 'Not found' });
    const { status, receiptNo, paidAmount, resultDesc } = snap.data();
    return res.json({ success: true, status, receiptNo, paidAmount, resultDesc });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ─── HTML builder ──────────────────────────────────────────────────────────
function buildCheckoutHTML({ tenantId, tenantName, unitCode, propertyName, amountDue, phone, agencyName, backendUrl, breakdown }) {
  const initials = agencyName.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  const formattedAmount = Number(amountDue).toLocaleString('en-KE');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<title>Pay Rent — ${agencyName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;background:#0a0a0f;color:#fff;font-family:'Inter',sans-serif}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:16px}

  .card{width:100%;max-width:400px;background:#13131a;border:1px solid rgba(255,255,255,.08);border-radius:24px;overflow:hidden;box-shadow:0 32px 80px rgba(0,0,0,.6)}

  /* header */
  .header{padding:28px 28px 20px;background:linear-gradient(135deg,#1a1a2e,#16213e);border-bottom:1px solid rgba(255,255,255,.06);display:flex;align-items:center;gap:14px}
  .avatar{width:46px;height:46px;border-radius:14px;background:linear-gradient(135deg,#00d4aa,#007aff);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;letter-spacing:-.5px;flex-shrink:0}
  .agency-name{font-size:15px;font-weight:700;color:#fff}
  .agency-label{font-size:11px;color:#64748b;margin-top:2px;font-weight:500}

  /* body */
  .body{padding:28px}

  .amount-block{text-align:center;margin-bottom:28px}
  .amount-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#64748b;margin-bottom:8px}
  .amount-input-wrapper {
    position: relative; display: flex; align-items: center; justify-content: center;
    background: #1e1e2a; border: 1.5px solid rgba(255,255,255,.1); border-radius: 14px;
    margin-bottom: 8px; padding: 0 16px; transition: border-color .2s; width: 100%;
  }
  .amount-input-wrapper:focus-within { border-color: #00d4aa; }
  .amount-currency { color: #00d4aa; font-weight: 700; font-size: 20px; margin-right: 8px; }
  .amount-input {
    background: transparent; border: none; color: #fff; font-size: 32px; font-weight: 800;
    font-family: 'Inter', sans-serif; outline: none; padding: 12px 0; width: 100%;
  }
  .amount-input::-webkit-outer-spin-button, .amount-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .amount-sub{font-size:13px;color:#475569;margin-top:4px;font-weight:500}

  .breakdown{background:#1e1e2a;border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:14px;margin-bottom:24px}
  .breakdown-row{display:flex;justify-content:space-between;margin-bottom:8px;font-size:13px;color:#94a3b8}
  .breakdown-row:last-child{margin-bottom:0}
  .breakdown-row span:last-child{font-weight:600;color:#e2e8f0}
  .breakdown-row.total{border-top:1px dashed rgba(255,255,255,.1);padding-top:8px;margin-top:4px;color:#fff}
  .breakdown-row.arrears span:last-child{color:#ef4444}

  .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px}
  .info-item{background:#1e1e2a;border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:14px}
  .info-item.full{grid-column:1/-1}
  .info-key{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#475569;margin-bottom:5px}
  .info-val{font-size:14px;font-weight:600;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

  .field-label{font-size:12px;font-weight:600;color:#64748b;margin-bottom:8px;display:block}
  .field-input{width:100%;background:#1e1e2a;border:1.5px solid rgba(255,255,255,.1);border-radius:14px;padding:14px 16px;color:#fff;font-size:16px;font-family:'Inter',sans-serif;outline:none;transition:border-color .2s}
  .field-input:focus{border-color:#00d4aa}
  .field-hint{font-size:11px;color:#475569;margin-top:6px}

  .btn-pay{width:100%;margin-top:20px;padding:17px;background:linear-gradient(135deg,#00d4aa,#007aff);border:none;border-radius:16px;color:#fff;font-size:16px;font-weight:700;font-family:'Inter',sans-serif;cursor:pointer;transition:opacity .2s,transform .1s;letter-spacing:-.2px;position:relative;overflow:hidden}
  .btn-pay:active{transform:scale(.98)}
  .btn-pay:disabled{opacity:.5;cursor:not-allowed}

  /* states */
  .state{display:none;flex-direction:column;align-items:center;text-align:center;padding:12px 0}
  .state.active{display:flex}

  /* spinner */
  .spinner{width:44px;height:44px;border:3px solid rgba(255,255,255,.1);border-top-color:#00d4aa;border-radius:50%;animation:spin .8s linear infinite;margin-bottom:16px}
  @keyframes spin{to{transform:rotate(360deg)}}

  /* success */
  .icon-circle{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;margin-bottom:16px}
  .icon-circle.success{background:rgba(0,212,170,.15);border:1.5px solid rgba(0,212,170,.3)}
  .icon-circle.error{background:rgba(239,68,68,.15);border:1.5px solid rgba(239,68,68,.3)}
  .state-title{font-size:18px;font-weight:700;margin-bottom:6px}
  .state-desc{font-size:13px;color:#64748b;line-height:1.6;max-width:280px}
  .receipt-badge{margin-top:14px;background:#1e1e2a;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 16px;font-size:12px;color:#94a3b8;font-family:monospace}

  .btn-retry{margin-top:18px;padding:12px 28px;background:transparent;border:1.5px solid rgba(255,255,255,.12);border-radius:12px;color:#94a3b8;font-size:14px;font-family:'Inter',sans-serif;cursor:pointer;font-weight:600}
  .btn-retry:hover{border-color:rgba(255,255,255,.25);color:#fff}

  .footer{padding:16px 28px;border-top:1px solid rgba(255,255,255,.06);text-align:center}
  .footer p{font-size:11px;color:#334155;display:flex;align-items:center;justify-content:center;gap:6px}
  .footer span{color:#00d4aa;font-weight:700}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <div class="avatar">${initials}</div>
    <div>
      <div class="agency-name">${escHtml(agencyName)}</div>
      <div class="agency-label">Secure Rent Payment</div>
    </div>
  </div>

  <div class="body">
    <!-- DEFAULT STATE -->
    <div id="state-default">
      <div class="amount-block">
        <div class="amount-label">Amount To Pay</div>
        <div class="amount-input-wrapper">
          <span class="amount-currency">KSh</span>
          <input id="pay-amount" class="amount-input" type="number" inputmode="decimal" value="${amountDue}" min="1" step="1"/>
        </div>
        <div class="amount-sub">You can adjust the amount to make a partial payment.</div>
      </div>

      <div class="breakdown">
        ${breakdown.rent > 0 ? \`<div class="breakdown-row"><span>Rent</span><span>KSh \${breakdown.rent.toLocaleString('en-KE')}</span></div>\` : ''}
        ${breakdown.deposit > 0 ? \`<div class="breakdown-row"><span>Deposit</span><span>KSh \${breakdown.deposit.toLocaleString('en-KE')}</span></div>\` : ''}
        ${breakdown.garbage > 0 ? \`<div class="breakdown-row"><span>Garbage</span><span>KSh \${breakdown.garbage.toLocaleString('en-KE')}</span></div>\` : ''}
        ${breakdown.water > 0 ? \`<div class="breakdown-row"><span>Water</span><span>KSh \${breakdown.water.toLocaleString('en-KE')}</span></div>\` : ''}
        ${breakdown.electricity > 0 ? \`<div class="breakdown-row"><span>Electricity</span><span>KSh \${breakdown.electricity.toLocaleString('en-KE')}</span></div>\` : ''}
        ${breakdown.penalties > 0 ? \`<div class="breakdown-row"><span>Late Penalty</span><span>KSh \${breakdown.penalties.toLocaleString('en-KE')}</span></div>\` : ''}
        <div class="breakdown-row total"><span>Total Monthly Expected</span><span>KSh ${(breakdown.rent + breakdown.deposit + breakdown.garbage + breakdown.water + breakdown.electricity + breakdown.penalties).toLocaleString('en-KE')}</span></div>
        <div class="breakdown-row arrears"><span>System Arrears (Due)</span><span>KSh ${Number(amountDue).toLocaleString('en-KE')}</span></div>
      </div>

      <div class="info-grid">
        <div class="info-item">
          <div class="info-key">Tenant</div>
          <div class="info-val">${escHtml(tenantName)}</div>
        </div>
        <div class="info-item">
          <div class="info-key">Unit</div>
          <div class="info-val">${escHtml(unitCode) || '—'}</div>
        </div>
        ${propertyName ? `<div class="info-item full"><div class="info-key">Property</div><div class="info-val">${escHtml(propertyName)}</div></div>` : ''}
      </div>

      <label class="field-label" for="phone-input">M-Pesa Phone Number</label>
      <input id="phone-input" class="field-input" type="tel" inputmode="numeric"
             value="${escHtml(phone)}" placeholder="07XXXXXXXX" autocomplete="tel"/>
      <div class="field-hint">You will receive a prompt on this number to enter your PIN.</div>

      <button class="btn-pay" id="btn-pay" onclick="payNow()">Confirm & Pay</button>
    </div>

    <!-- PROCESSING STATE -->
    <div class="state" id="state-loading">
      <div class="spinner"></div>
      <div class="state-title">Check Your Phone</div>
      <div class="state-desc">An M-Pesa prompt has been sent to your phone. Enter your PIN to complete the payment.</div>
    </div>

    <!-- SUCCESS STATE -->
    <div class="state" id="state-success">
      <div class="icon-circle success">✓</div>
      <div class="state-title">Payment Received!</div>
      <div class="state-desc">Your rent payment of <strong>KSh ${formattedAmount}</strong> has been confirmed.</div>
      <div class="receipt-badge" id="receipt-no">M-Pesa Receipt: —</div>
    </div>

    <!-- ERROR STATE -->
    <div class="state" id="state-error">
      <div class="icon-circle error">✕</div>
      <div class="state-title">Payment Failed</div>
      <div class="state-desc" id="error-msg">The payment could not be completed. Please try again.</div>
      <button class="btn-retry" onclick="reset()">Try Again</button>
    </div>
  </div>

  <div class="footer">
    <p>🔒 Secured by <span>KodiPay</span> · Powered by M-Pesa</p>
  </div>
</div>

<script>
  const TENANT_ID  = '${escHtml(tenantId)}';
  const AMOUNT     = ${amountDue};
  const BACKEND    = '${backendUrl}';
  let checkoutId   = null;
  let pollTimer    = null;

  function showState(id) {
    ['state-default','state-loading','state-success','state-error'].forEach(s => {
      const el = document.getElementById(s);
      el.classList.toggle('active', s === id);
      el.style.display = s === id ? (s === 'state-default' ? 'block' : 'flex') : 'none';
    });
  }

  async function payNow() {
    const phone = document.getElementById('phone-input').value.trim();
    const finalAmount = document.getElementById('pay-amount').value;
    
    if (!phone || phone.length < 9) {
      alert('Please enter a valid M-Pesa phone number.');
      return;
    }
    if (!finalAmount || finalAmount < 1) {
      alert('Please enter a valid amount to pay.');
      return;
    }

    document.getElementById('btn-pay').disabled = true;
    showState('state-loading');

    try {
      const res  = await fetch(BACKEND + '/api/pay/stk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: TENANT_ID, phone, amount: finalAmount })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Request failed');
      checkoutId = data.checkoutRequestId;
      startPolling();
    } catch (err) {
      document.getElementById('error-msg').textContent = err.message;
      showState('state-error');
    }
  }

  function startPolling() {
    let attempts = 0;
    pollTimer = setInterval(async () => {
      attempts++;
      try {
        const res  = await fetch(BACKEND + '/api/pay/status/' + checkoutId);
        const data = await res.json();
        if (data.status === 'completed') {
          clearInterval(pollTimer);
          document.getElementById('receipt-no').textContent = 'M-Pesa Receipt: ' + (data.receiptNo || '—');
          showState('state-success');
        } else if (data.status === 'failed') {
          clearInterval(pollTimer);
          document.getElementById('error-msg').textContent = data.resultDesc || 'Payment was declined or cancelled.';
          showState('state-error');
        }
      } catch (_) {}
      if (attempts >= 20) { // 60s timeout
        clearInterval(pollTimer);
        document.getElementById('error-msg').textContent = 'Timed out waiting for confirmation. If you entered your PIN, your payment may still be processing.';
        showState('state-error');
      }
    }, 3000);
  }

  function reset() {
    clearInterval(pollTimer);
    document.getElementById('btn-pay').disabled = false;
    showState('state-default');
  }

  // Init
  showState('state-default');
</script>
</body>
</html>`;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = { checkoutPage, initiateStk, stkCallback, checkStatus };
