const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Reusing token generator from mpesaService if possible, or rewrite
// But mpesaService uses SUBSCRIPTION_CONSUMER_KEY. Here we use the agency's dedicated credentials.

const MPESA_ENV = process.env.MPESA_ENV || 'production';
const DARAJA_BASE_URL = MPESA_ENV === 'sandbox' ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';

class MpesaPayoutService {
  async getAccessToken(consumerKey, consumerSecret) {
    const url = `${DARAJA_BASE_URL}/oauth/v2/generate?grant_type=client_credentials`;
    const auth = 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const response = await axios.get(url, { headers: { Authorization: auth } });
    return response.data.access_token;
  }

  getSecurityCredential(password) {
    const certPath = path.resolve(__dirname, '../../ProductionCertificate.cer');
    const pubKey = fs.readFileSync(certPath, 'utf8');
    const buffer = Buffer.from(password);
    const encrypted = crypto.publicEncrypt({
      key: pubKey,
      padding: crypto.constants.RSA_PKCS1_PADDING
    }, buffer);
    return encrypted.toString('base64');
  }

  formatPhone(phone) {
    let formattedPhone = phone.trim().replace(/\+/g, '');
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '254' + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) {
      formattedPhone = '254' + formattedPhone;
    }
    return formattedPhone;
  }

  async triggerB2C(credentials, amount, phone, remarks, receiptRef) {
    console.log(`💸 Initiating B2C Payout of KSh ${amount} to ${phone}`);
    try {
      const token = await this.getAccessToken(credentials.consumerKey, credentials.consumerSecret);
      const url = `${DARAJA_BASE_URL}/mpesa/b2c/v1/paymentrequest`;
      const auth = `Bearer ${token}`;

      let baseUrl = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'https://rent-manager-server.onrender.com';
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

      const payload = {
        InitiatorName: credentials.initiatorName,
        SecurityCredential: this.getSecurityCredential(credentials.securityCredential),
        CommandID: 'BusinessPayment',
        Amount: Math.round(amount),
        PartyA: credentials.shortCode,
        PartyB: this.formatPhone(phone),
        Remarks: remarks || 'Disbursal',
        QueueTimeOutURL: `${baseUrl}/api/webhook/gateway/timeout`,
        ResultURL: `${baseUrl}/api/webhook/gateway/result`,
        Occasion: receiptRef || 'Payout'
      };

      const response = await axios.post(url, payload, { headers: { Authorization: auth } });
      console.log('✅ B2C Response:', response.data);
      return response.data;
    } catch (error) {
      console.error('❌ B2C Payout failed:', error.response ? error.response.data : error.message);
      throw error;
    }
  }

  async triggerB2B(credentials, amount, receiverShortCode, type, remarks, accountRef) {
    console.log(`💸 Initiating B2B Payout of KSh ${amount} to ${receiverShortCode} (${type})`);
    try {
      const token = await this.getAccessToken(credentials.consumerKey, credentials.consumerSecret);
      const url = `${DARAJA_BASE_URL}/mpesa/b2b/v1/paymentrequest`;
      const auth = `Bearer ${token}`;

      let baseUrl = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'https://rent-manager-server.onrender.com';
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

      let commandId = 'BusinessToBusinessTransfer';
      let recieverIdentifierType = '4'; // Default: Organization/Paybill
      if (type === 'till') {
        commandId = 'BusinessBuyGoods';
        recieverIdentifierType = '2'; // Till Number (Buy Goods)
      } else if (type === 'paybill') {
        commandId = 'BusinessPayBill';
        recieverIdentifierType = '4'; // Organization shortcode
      }

      console.log(`🔧 B2B Config — CommandID: ${commandId}, ReceiverType: ${recieverIdentifierType}`);

      const payload = {
        Initiator: credentials.initiatorName,
        SecurityCredential: this.getSecurityCredential(credentials.securityCredential),
        CommandID: commandId,
        SenderIdentifierType: '4',       // Sender is always Paybill (Organization)
        RecieverIdentifierType: recieverIdentifierType,
        Amount: Math.round(amount),
        PartyA: credentials.shortCode,
        PartyB: receiverShortCode,
        AccountReference: accountRef || 'Disbursal',
        Remarks: remarks || 'Disbursal',
        QueueTimeOutURL: `${baseUrl}/api/webhook/gateway/timeout`,
        ResultURL: `${baseUrl}/api/webhook/gateway/result`
      };

      const response = await axios.post(url, payload, { headers: { Authorization: auth } });
      console.log('✅ B2B Response:', response.data);
      return response.data;
    } catch (error) {
      console.error('❌ B2B Payout failed:', error.response ? error.response.data : error.message);
      throw error;
    }
  }
}

module.exports = new MpesaPayoutService();