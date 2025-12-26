// ============================================
// FILE: src/services/pdfService.js
// ============================================
const puppeteer = require('puppeteer');

class PdfService {
    /**
     * Generate PDF Buffer from HTML content
     * @param {string} htmlContent - The full HTML string
     * @returns {Promise<Buffer>} - PDF buffer
     */
    async generatePdf(htmlContent) {
        let browser = null;
        try {
            console.log('[PdfService] Launching browser for PDF generation...');

            // Launch puppeteer
            // args: ['--no-sandbox'] often needed for cloud envs/docker, good practice
            browser = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            });

            const page = await browser.newPage();

            // Set viewport to high resolution to avoid any rasterization blur
            await page.setViewport({
                width: 1240,
                height: 1754, // A4 pixel size approx at 150dpi
                deviceScaleFactor: 2,
            });

            await page.emulateMediaType('screen');

            // Set content
            // waitUntil: 'networkidle0' ensures fonts/images load
            await page.setContent(htmlContent, {
                waitUntil: 'networkidle0',
                timeout: 30000,
            });

            // Generate PDF
            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true,
                margin: {
                    top: '20px',
                    bottom: '20px',
                    left: '20px',
                    right: '20px',
                },
            });

            console.log(`[PdfService] PDF generated successfully (${pdfBuffer.length} bytes)`);
            return pdfBuffer;

        } catch (error) {
            console.error('[PdfService] Error generating PDF:', error);
            throw error;
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }
}

module.exports = new PdfService();
