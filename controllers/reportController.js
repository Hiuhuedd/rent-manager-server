// ============================================
// FILE: src/controllers/reportController.js
// ============================================
const reportService = require('../services/reportService');
const { createSuccessResponse } = require('../utils/responseHelper');

const pdfService = require('../services/pdfService');

class ReportController {
    async generatePropertyReport(req, res) {
        const { propertyId, month } = req.params;

        if (!propertyId || !month) {
            return res.status(400).json({
                success: false,
                error: 'Property ID and Month (YYYY-MM) are required'
            });
        }

        const report = await reportService.generatePropertyReport(propertyId, month);
        res.json(createSuccessResponse(report));
    }

    async downloadReportPdf(req, res) {
        const { propertyId, month } = req.params;

        if (!propertyId || !month) {
            return res.status(400).json({ success: false, error: 'Missing params' });
        }

        try {
            // 1. Get Data
            const reportData = await reportService.generatePropertyReport(propertyId, month);
            if (!reportData) throw new Error('Could not generate report data');

            // 2. Format HTML (Shared Template Logic)
            const html = this._generateHtmlTemplate(reportData, month);

            // 3. Generate PDF
            const pdfBuffer = await pdfService.generatePdf(html);

            // 4. Send Response
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=Report_${reportData.property.name}_${month}.pdf`);
            res.setHeader('Content-Length', pdfBuffer.length);
            res.send(pdfBuffer);

        } catch (error) {
            console.error('Error in downloadReportPdf:', error);
            res.status(500).json({ success: false, error: 'Failed to generate PDF' });
        }
    }

    _generateHtmlTemplate(reportData, selectedMonth) {
        // Helper to format currency
        const formatCurrency = (amount) => `KSH ${amount ? amount.toLocaleString() : '0'}`;

        return `
        <html>
          <head>
            <style>
              body { font-family: 'Helvetica', sans-serif; padding: 40px; color: #333; }
              .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #eee; padding-bottom: 20px; }
              .title { font-size: 24px; font-weight: bold; margin-bottom: 5px; }
              .subtitle { font-size: 14px; color: #666; }
              .section { margin-bottom: 30px; }
              .section-title { font-size: 16px; font-weight: bold; margin-bottom: 12px; color: #555; border-bottom: 1px solid #eee; padding-bottom: 5px; }
              .row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; }
              .total-row { display: flex; justify-content: space-between; margin-top: 15px; padding-top: 10px; border-top: 1px solid #ddd; font-weight: bold; font-size: 16px; }
              .net-income { background-color: #f8f9fa; padding: 20px; border-radius: 12px; margin-top: 40px; text-align: center; border: 1px solid #eee; }
              .net-income-label { font-size: 14px; color: #666; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; }
              .net-income-value { font-size: 32px; font-weight: bold; color: #2ecc71; }
              .footer { margin-top: 60px; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #eee; padding-top: 20px; }
            </style>
          </head>
          <body>
            <div class="header">
              <div class="title">${reportData.property.name}</div>
              <div class="subtitle">Monthly Financial Report • ${selectedMonth}</div>
            </div>

            <div class="section">
              <div class="section-title">Income Summary</div>
              <div class="row">
                <span>Rent Collected (${reportData.financials.income.transactionCount} txns)</span>
                <span>${formatCurrency(reportData.financials.income.total)}</span>
              </div>
            </div>

            <div class="section">
              <div class="section-title">Operating Expenses</div>
              ${Object.entries(reportData.financials.expenses.byCategory || {}).map(([cat, amt]) => `
                <div class="row">
                  <span>${cat}</span>
                  <span>${formatCurrency(amt)}</span>
                </div>
              `).join('')}
              ${reportData.financials.expenses.transactionCount === 0 ? '<div class="row" style="color:#999; font-style:italic;">No expenses recorded</div>' : ''}
              <div class="total-row">
                <span>Total Expenses</span>
                <span>${formatCurrency(reportData.financials.expenses.total)}</span>
              </div>
            </div>

            <div class="net-income">
              <div class="net-income-label">Net Income</div>
              <div class="net-income-value">${formatCurrency(reportData.financials.netIncome)}</div>
            </div>

            <div class="footer">
              Generated by RentManager • ${new Date().toLocaleDateString()}
            </div>
          </body>
        </html>
      `;
    }
}

module.exports = new ReportController();
