// ============================================
// FILE: src/controllers/reportController.js
// ============================================
const reportService = require('../services/reportService');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');
const pdfService = require('../services/pdfService');

class ReportController {
  generatePropertyReport = async (req, res) => {
    try {
      const { propertyId, month } = req.params;
      const { agencyId } = req.user;

      if (!propertyId || !month) {
        return res.status(400).json(createErrorResponse('Property ID and Month (YYYY-MM) are required'));
      }

      const report = await reportService.generatePropertyReport(propertyId, month, agencyId);
      res.json(createSuccessResponse(report));
    } catch (error) {
      res.status(403).json(createErrorResponse(error.message));
    }
  }

  generatePortfolioReport = async (req, res) => {
    try {
      const { month } = req.params;
      const { agencyId } = req.user;

      if (!month) {
        return res.status(400).json(createErrorResponse('Month (YYYY-MM) is required'));
      }

      const report = await reportService.generatePortfolioReport(agencyId, month);
      res.json(createSuccessResponse(report));
    } catch (error) {
      res.status(403).json(createErrorResponse(error.message));
    }
  }

  getTenantStatement = async (req, res) => {
    try {
      const { tenantId } = req.params;
      const { agencyId } = req.user;

      if (!tenantId) {
        return res.status(400).json(createErrorResponse('Tenant ID is required'));
      }

      const statement = await reportService.generateTenantStatement(tenantId, agencyId);
      res.json(createSuccessResponse(statement));
    } catch (error) {
      res.status(403).json(createErrorResponse(error.message));
    }
  }

  downloadReportPdf = async (req, res) => {
    try {
      const { propertyId, month } = req.params;
      const { agencyId } = req.user;

      if (!propertyId || !month) {
        return res.status(400).json(createErrorResponse('Missing params'));
      }

      const reportData = await reportService.generatePropertyReport(propertyId, month, agencyId);
      if (!reportData) throw new Error('Could not generate report data');

      const reportColor = req.query.reportColor || '#007aff';
      const html = this._generateHtmlTemplate(reportData, month, reportColor);
      const pdfBuffer = await pdfService.generatePdf(html);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=Report_${reportData.property.name}_${month}.pdf`);
      res.setHeader('Content-Length', pdfBuffer.length);
      res.send(pdfBuffer);
    } catch (error) {
      res.status(403).json(createErrorResponse(error.message));
    }
  }

  downloadPortfolioReportPdf = async (req, res) => {
    try {
      const { month } = req.params;
      const { agencyId } = req.user;

      if (!month) {
        return res.status(400).json(createErrorResponse('Month (YYYY-MM) is required'));
      }

      const portfolioData = await reportService.generatePortfolioReport(agencyId, month);
      if (!portfolioData) throw new Error('Could not generate portfolio data');

      const reportColor = req.query.reportColor || '#007aff';
      const html = this._generatePortfolioHtmlTemplate(portfolioData, month, reportColor);
      const pdfBuffer = await pdfService.generatePdf(html);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=Portfolio_Report_${month}.pdf`);
      res.setHeader('Content-Length', pdfBuffer.length);
      res.send(pdfBuffer);
    } catch (error) {
      res.status(403).json(createErrorResponse(error.message));
    }
  }

  downloadTenantStatementPdf = async (req, res) => {
    try {
      const { tenantId } = req.params;
      const { agencyId } = req.user;

      if (!tenantId) {
        return res.status(400).json(createErrorResponse('Tenant ID is required'));
      }

      const statementData = await reportService.generateTenantStatement(tenantId, agencyId);
      if (!statementData) throw new Error('Could not generate statement data');

      const reportColor = req.query.reportColor || '#007aff';
      const html = this._generateTenantStatementHtmlTemplate(statementData, reportColor);
      const pdfBuffer = await pdfService.generatePdf(html);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=Statement_${statementData.tenant.name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`);
      res.setHeader('Content-Length', pdfBuffer.length);
      res.send(pdfBuffer);
    } catch (error) {
      res.status(403).json(createErrorResponse(error.message));
    }
  }

  _generatePortfolioHtmlTemplate(data, selectedMonth, reportColor = '#007aff') {
    const agency = data.meta.agency;
    return `
        <html>
          <head>
            <style>
              body { font-family: 'Helvetica', sans-serif; padding: 0; margin: 0; color: #333; line-height: 1.6; }
              .premium-header-block { background-color: ${reportColor}; padding: 40px 40px 30px 40px; margin-bottom: 30px; }
              .content-wrapper { padding: 0 40px 40px 40px; }
              .report-title-letterhead { text-align: center; margin: 0; background-color: transparent; padding: 15px 0; border-bottom: 1px solid rgba(255,255,255,0.2); margin-bottom: 20px; }
              .report-title { font-size: 11px; font-weight: 900; color: rgba(255,255,255,0.8); letter-spacing: 3px; text-transform: uppercase; }
              .report-header { display: flex; justify-content: space-between; align-items: flex-start; }
              .property-info { flex: 1; }
              .property-name { font-size: 24px; font-weight: 900; color: #ffffff; text-transform: uppercase; margin-bottom: 4px; }
              .period-container { text-align: right; }
              .period-label { font-size: 10px; font-weight: bold; color: rgba(255,255,255,0.7); text-transform: uppercase; margin-bottom: 2px; letter-spacing: 1px; }
              .period-value { font-size: 14px; font-weight: bold; color: #ffffff; }
              .section { margin-bottom: 35px; }
              .section-title { font-size: 16px; font-weight: bold; margin-bottom: 15px; color: ${reportColor}; border-bottom: 1px solid #eee; padding-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; }
              table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
              th { text-align: left; font-size: 10px; color: #888; text-transform: uppercase; padding: 10px; border-bottom: 1px solid #eee; }
              td { padding: 12px 10px; font-size: 12px; border-bottom: 1px solid #f9f9f9; }
              .row { display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 14px; }
              .total-row { display: flex; justify-content: space-between; margin-top: 15px; padding-top: 10px; border-top: 2px solid #333; font-weight: bold; font-size: 16px; }
              .net-income { background-color: ${reportColor}; color: white; padding: 25px; border-radius: 12px; margin-top: 20px; text-align: center; }
              .dashed-line { border-top: 2px dashed #eee; margin: 25px 0; width: 100%; }
              .footer { margin-top: 60px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #eee; padding-top: 20px; }
            </style>
          </head>
          <body>
            <div class="premium-header-block">
              <div class="report-title-letterhead">
                <div class="report-title" style="font-size: 14px; color: #FFF; margin-bottom: 4px;">${agency.name.toUpperCase()}</div>
                <div class="report-title">Monthly Portfolio Report</div>
              </div>
              <div class="report-header">
                <div class="property-info">
                  <div class="property-name">All Properties</div>
                  <div class="owner-name" style="color:rgba(255,255,255,0.9); font-size:13px;">${data.summary.totalProperties} Properties Managed</div>
                </div>
                <div class="period-container">
                  <div class="period-label">Period</div>
                  <div class="period-value">${new Date(selectedMonth + '-01').toLocaleDateString('default', { month: 'short', year: 'numeric' }).toUpperCase()}</div>
                </div>
              </div>
            </div>
            <div class="content-wrapper">
                <div class="dashed-line" style="margin-top: 0;"></div>
                <div class="section">
                  <div class="section-title">Portfolio Overview (KSH)</div>
                  <div style="display: flex; gap: 20px; margin-bottom: 20px;">
                      <div style="flex: 1; background: #f9fafb; padding: 15px; border-radius: 8px; border: 1px solid #eee;">
                        <div style="font-size: 11px; color: #666; text-transform: uppercase;">Total Expected</div>
                        <div style="font-size: 20px; font-weight: bold; color: #333; margin-top: 5px;">${data.summary.totalExpected.toLocaleString()}</div>
                      </div>
                      <div style="flex: 1; background: #f0fdf4; padding: 15px; border-radius: 8px; border: 1px solid #dcfce7;">
                        <div style="font-size: 11px; color: #166534; text-transform: uppercase;">Total Collected</div>
                        <div style="font-size: 20px; font-weight: bold; color: #16a34a; margin-top: 5px;">${data.summary.totalCollected.toLocaleString()}</div>
                      </div>
                      <div style="flex: 1; background: #fef2f2; padding: 15px; border-radius: 8px; border: 1px solid #fee2e2;">
                        <div style="font-size: 11px; color: #991b1b; text-transform: uppercase;">Total Unpaid</div>
                        <div style="font-size: 20px; font-weight: bold; color: #dc2626; margin-top: 5px;">${data.summary.totalUnpaid.toLocaleString()}</div>
                      </div>
                  </div>
                </div>
                <div class="section">
                  <div class="section-title">Property Breakdown</div>
                  <table>
                    <thead>
                      <tr>
                        <th style="width: 25%;">Property</th>
                        <th style="width: 20%;">Owner</th>
                        <th style="width: 10%; text-align: center;">Occ.</th>
                        <th style="width: 15%; text-align: right;">Expected</th>
                        <th style="width: 15%; text-align: right;">Collected</th>
                        <th style="width: 15%; text-align: right;">Unpaid</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${data.properties.map(p => `
                        <tr>
                          <td style="font-weight: bold;">${p.name}</td>
                          <td style="color: #666;">${p.owner}</td>
                          <td style="text-align: center;">${p.occupied}/${p.units}</td>
                          <td style="text-align: right;">${p.expected.toLocaleString()}</td>
                          <td style="text-align: right;">${p.collected.toLocaleString()}</td>
                          <td style="text-align: right; color: ${p.unpaid > 0 ? '#dc2626' : '#16a34a'}; font-weight: ${p.unpaid > 0 ? 'bold' : 'normal'};">
                            ${p.unpaid.toLocaleString()}
                          </td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
                <div class="dashed-line" style="margin-bottom: 30px;"></div>
                <div class="footer">
                  This report remains the property of ${agency.name}. Generated on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}.<br/>
                  For enquiries, contact us at ${agency.contact}
                </div>
            </div>
          </body>
        </html>
    `;
  }

  _generateHtmlTemplate(reportData, selectedMonth, reportColor = '#007aff') {
    const agency = reportData.meta.agency;
    const owner = reportData.meta.owner;
    const tenants = reportData.tenants || [];
    return `
        <html>
          <head>
            <style>
              body { font-family: 'Helvetica', sans-serif; padding: 0; margin: 0; color: #333; line-height: 1.6; }
              .premium-header-block { background-color: ${reportColor}; padding: 40px 40px 30px 40px; margin-bottom: 30px; }
              .content-wrapper { padding: 0 40px 40px 40px; }
              .report-title-letterhead { text-align: center; margin: 0; background-color: transparent; padding: 15px 0; border-bottom: 1px solid rgba(255,255,255,0.2); margin-bottom: 20px; }
              .report-title { font-size: 11px; font-weight: 900; color: rgba(255,255,255,0.8); letter-spacing: 3px; text-transform: uppercase; }
              .report-header { display: flex; justify-content: space-between; align-items: flex-start; }
              .property-info { flex: 1; }
              .property-name { font-size: 24px; font-weight: 900; color: #ffffff; text-transform: uppercase; margin-bottom: 4px; }
              .owner-name { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.9); text-transform: uppercase; }
              .period-container { text-align: right; }
              .period-label { font-size: 10px; font-weight: bold; color: rgba(255,255,255,0.7); text-transform: uppercase; margin-bottom: 2px; letter-spacing: 1px; }
              .period-value { font-size: 14px; font-weight: bold; color: #ffffff; }
              .section { margin-bottom: 35px; }
              .section-title { font-size: 16px; font-weight: bold; margin-bottom: 15px; color: ${reportColor}; border-bottom: 1px solid #eee; padding-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; }
              table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
              th { text-align: left; font-size: 11px; color: #888; text-transform: uppercase; padding: 10px; border-bottom: 1px solid #eee; }
              td { padding: 12px 10px; font-size: 13px; border-bottom: 1px solid #f9f9f9; }
              .row { display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 14px; }
              .total-row { display: flex; justify-content: space-between; margin-top: 15px; padding-top: 10px; border-top: 2px solid #333; font-weight: bold; font-size: 16px; }
              .net-income { background-color: ${reportColor}; color: white; padding: 25px; border-radius: 12px; margin-top: 20px; text-align: center; }
              .dashed-line { border-top: 2px dashed #eee; margin: 25px 0; width: 100%; }
              .footer { margin-top: 60px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #eee; padding-top: 20px; }
            </style>
          </head>
          <body>
            <div class="premium-header-block">
              <div class="report-title-letterhead">
                <div class="report-title" style="font-size: 14px; color: #FFF; margin-bottom: 4px;">${agency.name.toUpperCase()}</div>
                <div class="report-title">Monthly Financial Statement</div>
              </div>
              <div class="report-header">
                <div class="property-info">
                  <div class="property-name">${reportData.property.name}</div>
                  <div class="owner-name">${owner.name || 'Private Client'}</div>
                </div>
                <div class="period-container">
                  <div class="period-label">Period</div>
                  <div class="period-value">${new Date(selectedMonth + '-01').toLocaleDateString('default', { month: 'short', year: 'numeric' }).toUpperCase()}</div>
                </div>
              </div>
            </div>
            <div class="content-wrapper">
                <div class="dashed-line" style="margin-top: 0;"></div>
                <div class="section">
                  <div class="section-title">Tenant Payment Schedule</div>
                  <table>
                    <thead>
                      <tr>
                        <th style="width: 8%;">Unit</th>
                        <th style="width: 22%;">Tenant</th>
                        <th style="width: 12%; text-align: right;">Rent</th>
                        <th style="width: 10%; text-align: right;">Water</th>
                        <th style="width: 10%; text-align: right;">Garb.</th>
                        <th style="width: 10%; text-align: right;">Elec.</th>
                        <th style="width: 14%; text-align: right;">Paid</th>
                        <th style="width: 14%; text-align: right;">Unpaid</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${tenants.map(t => {
      const water = t.utilityFees?.waterBill || 0;
      const garbage = t.utilityFees?.garbageFee || 0;
      const electricity = t.utilityFees?.electricityBill || 0;
      const rent = (t.expectedAmount || 0) - water - garbage - electricity;
      return `
                        <tr>
                          <td>${t.unitName}</td>
                          <td>${t.tenantName}</td>
                          <td style="text-align: right;">${rent.toLocaleString()}</td>
                          <td style="text-align: right;">${water.toLocaleString()}</td>
                          <td style="text-align: right;">${garbage.toLocaleString()}</td>
                          <td style="text-align: right;">${electricity.toLocaleString()}</td>
                          <td style="text-align: right;">${t.amountPaid ? t.amountPaid.toLocaleString() : '0'}</td>
                          <td style="text-align: right; color: ${t.unpaidAmount > 0 ? '#c53030' : '#1f8b24'}; font-weight: bold;">
                            ${t.unpaidAmount ? t.unpaidAmount.toLocaleString() : '0'}
                          </td>
                        </tr>
                      `}).join('')}
                    </tbody>
                  </table>
                </div>
                <div class="dashed-line"></div>
                <div style="display: flex; gap: 40px;">
                    <div class="section" style="flex: 1;">
                      <div class="section-title">Income Summary (KSH)</div>
                      <div class="row"><span>Total Expected</span><span>${reportData.financials.income.expected?.toLocaleString() || '0'}</span></div>
                      <div class="row"><span>Total Unpaid</span><span style="color: #c53030;">${reportData.financials.income.unpaid?.toLocaleString() || '0'}</span></div>
                      <div class="total-row"><span>Rent Collections</span><span>${reportData.financials.income.total?.toLocaleString()}</span></div>
                    </div>
                    <div class="section" style="flex: 1;">
                      <div class="section-title">Operating Expenses (KSH)</div>
                      ${(reportData.financials.expenses.items || []).map(item => `<div class="row"><span>${item.name}</span><span>${item.amount?.toLocaleString()}</span></div>`).join('')}
                      <div class="section-title" style="margin-top: 20px;">Agency Commission (KSH)</div>
                      <div class="row"><span>Management Fee (${reportData.financials.commission?.rate || 8}%)</span><span>${reportData.financials.commission?.total?.toLocaleString()}</span></div>
                      <div class="total-row"><span>Total Expenses</span><span>${reportData.financials.expenses.total?.toLocaleString()}</span></div>
                    </div>
                </div>
                <div class="dashed-line"></div>
                <div class="section">
                  <div class="section-title">Summary (KSH)</div>
                  <div class="row" style="margin-top: 10px;"><span style="font-weight: 900; font-size: 16px;">NET MONTHLY INCOME</span><span style="font-weight: 900; font-size: 18px; color: ${reportColor};">${reportData.financials.netIncome?.toLocaleString()}</span></div>
                </div>
                <div class="dashed-line" style="margin-bottom: 30px;"></div>
                <div class="footer">This report remains the property of ${agency.name}. Generated on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}.<br/>For enquiries, contact us at ${agency.contact}</div>
            </div>
          </body>
        </html>
    `;
  }

  _generateTenantStatementHtmlTemplate(data, reportColor = '#007aff') {
    const agency = data.meta.agency;
    const tenant = data.tenant;
    const formatMoney = (amount) => `KSH ${amount ? amount.toLocaleString() : '0'}`;
    const formatDate = (dateStr) => dateStr ? new Date(dateStr).toLocaleDateString('default', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';

    return `
        <html>
          <head>
            <style>
              body { font-family: 'Helvetica', sans-serif; padding: 0; margin: 0; color: #333; line-height: 1.6; }
              .premium-header-block { background-color: ${reportColor}; padding: 40px 40px 30px 40px; margin-bottom: 30px; }
              .content-wrapper { padding: 0 40px 40px 40px; }
              .report-title-letterhead { text-align: center; margin: 0; background-color: transparent; padding: 15px 0; border-bottom: 1px solid rgba(255,255,255,0.2); margin-bottom: 20px; }
              .report-title { font-size: 11px; font-weight: 900; color: rgba(255,255,255,0.8); letter-spacing: 3px; text-transform: uppercase; }
              .report-header { display: flex; justify-content: space-between; align-items: flex-start; }
              .property-info { flex: 1; }
              .property-name { font-size: 24px; font-weight: 900; color: #ffffff; text-transform: uppercase; margin-bottom: 4px; }
              .tenant-meta { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.9); }
              .section-title { font-size: 16px; font-weight: bold; margin-bottom: 15px; color: ${reportColor}; border-bottom: 1px solid #eee; padding-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; }
              table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
              th { text-align: left; font-size: 10px; color: #888; text-transform: uppercase; padding: 10px; border-bottom: 1px solid #eee; }
              td { padding: 12px 10px; font-size: 12px; border-bottom: 1px solid #f9f9f9; }
              .summary-box { background: #f8fafc; padding: 20px; border-radius: 8px; margin-top: 30px; display: flex; justify-content: space-between; align-items: center; border: 1px solid #e2e8f0; }
              .summary-item { text-align: center; flex: 1; }
              .summary-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px; }
              .summary-value { font-size: 18px; font-weight: bold; color: #0f172a; }
              .footer { margin-top: 60px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #eee; padding-top: 20px; }
            </style>
          </head>
          <body>
            <div class="premium-header-block">
              <div class="report-title-letterhead">
                <div class="report-title" style="font-size: 14px; color: #FFF; margin-bottom: 4px;">${agency.name.toUpperCase()}</div>
                <div class="report-title">Statement of Account</div>
              </div>
              <div class="report-header">
                <div class="property-info"><div class="property-name">${tenant.name}</div><div class="tenant-meta">Unit: ${tenant.unitName || tenant.unitCode} • ${tenant.propertyName}</div></div>
                <div class="period-container"><div class="period-label">Move In Date</div><div class="period-value">${formatDate(tenant.moveInDate)}</div></div>
              </div>
            </div>
            <div class="content-wrapper">
                <div class="summary-box">
                    <div class="summary-item"><div class="summary-label">Total Paid</div><div class="summary-value" style="color: #16a34a;">${formatMoney(data.summary.totalPaid)}</div></div>
                    <div class="summary-item" style="border-left: 1px solid #e2e8f0;"><div class="summary-label">Outstanding Balance</div><div class="summary-value" style="color: #dc2626;">${formatMoney(data.summary.balance)}</div></div>
                </div>
                <div class="section" style="margin-top: 30px;">
                  <div class="section-title">Transaction History</div>
                  <table>
                    <thead><tr><th>Date</th><th>Transaction Ref</th><th>Type</th><th>Status</th><th style="text-align: right;">Amount</th></tr></thead>
                    <tbody>${data.transactions.length > 0 ? data.transactions.map(t => `<tr><td>${formatDate(t.date)}</td><td style="font-family: monospace; font-size: 11px;">${t.transactionCode || t.mpesaReceiptNumber || '-'}</td><td>${(t.type || 'Payment').replace('_', ' ').toUpperCase()}</td><td>${t.status?.toUpperCase() || 'UNKNOWN'}</td><td style="text-align: right; font-weight: bold;">${formatMoney(t.amount)}</td></tr>`).join('') : '<tr><td colspan="5">No transactions found.</td></tr>'}</tbody>
                  </table>
                </div>
                <div class="footer">This statement is generated by ${agency.name}.<br/>Generated on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}.<br/>For billing enquiries, contact us at ${agency.contact}</div>
            </div>
          </body>
        </html>
    `;
  }
}

module.exports = new ReportController();
