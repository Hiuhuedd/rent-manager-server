// ============================================
// PROJECT STRUCTURE
// ============================================
/*
src/
├── server.js (main entry point)
├── config/
│   ├── firebase.js
│   └── constants.js
├── middleware/
│   ├── errorHandler.js
│   ├── validator.js
│   └── logger.js
├── controllers/
│   ├── propertyController.js
│   ├── tenantController.js
│   ├── paymentController.js
│   ├── webhookController.js
│   └── statsController.js
├── services/
│   ├── propertyService.js
│   ├── tenantService.js
│   ├── paymentService.js
│   ├── smsService.js
│   └── cronService.js
├── routes/
│   ├── index.js
│   ├── propertyRoutes.js
│   ├── tenantRoutes.js
│   ├── paymentRoutes.js
│   └── webhookRoutes.js
└── utils/
    ├── responseHelper.js
    └── dateHelper.js
*/

// ============================================
// FILE: src/server.js (Main Entry Point)
// ============================================
const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const { errorHandler } = require('./middleware/errorHandler');
const { requestLogger } = require('./middleware/logger');
const { initializeMonthlyCronJob, createManualResetEndpoint } = require('./services/cronService');

const app = express();

// Middleware
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));
app.use(requestLogger);

// Initialize cron jobs
initializeMonthlyCronJob();
createManualResetEndpoint(app);

// Routes
app.use('/api', routes);

// Error handling (must be last)
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
});

module.exports = app;

















// ============================================
// FILE: .env.example
// ============================================
/*
NODE_ENV=development
PORT=3000

# Firebase Configuration
FIREBASE_API_KEY=your_api_key
FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_STORAGE_BUCKET=your_project.appspot.com
FIREBASE_MESSAGING_SENDER_ID=your_sender_id
FIREBASE_APP_ID=your_app_id

# SMS Configuration
SMS_API_KEY=your_sms_api_key
SMS_SENDER_ID=your_sender_id

# Logging
LOG_LEVEL=info
*/

// ============================================
// FILE: README.md
// ============================================
/*
# Rental Management API - Restructured

## Project Structure

```
src/
├── server.js                 # Main entry point
├── config/
│   ├── firebase.js          # Firebase configuration
│   └── constants.js         # Application constants
├── middleware/
│   ├── errorHandler.js      # Error handling middleware
│   ├── validator.js         # Input validation middleware
│   └── logger.js            # Request logging middleware
├── controllers/
│   ├── propertyController.js
│   ├── tenantController.js
│   ├── paymentController.js
│   ├── webhookController.js
│   └── statsController.js
├── services/
│   ├── propertyService.js   # Business logic for properties
│   ├── tenantService.js     # Business logic for tenants
│   ├── paymentService.js    # Business logic for payments
│   ├── webhookService.js    # Webhook processing logic
│   ├── statsService.js      # Statistics calculation
│   ├── smsService.js        # SMS operations wrapper
│   └── cronService.js       # Cron job management
├── routes/
│   ├── index.js             # Main router
│   ├── propertyRoutes.js
│   ├── tenantRoutes.js
│   ├── paymentRoutes.js
│   ├── webhookRoutes.js
│   └── statsRoutes.js
└── utils/
    ├── responseHelper.js    # Standardized responses
    └── dateHelper.js        # Date utility functions
```

## Key Features

### 1. Separation of Concerns
- **Controllers**: Handle HTTP requests and responses
- **Services**: Contain business logic and data operations
- **Routes**: Define API endpoints and apply middleware
- **Middleware**: Handle cross-cutting concerns
- **Utils**: Reusable helper functions

### 2. Error Handling
- Centralized error handler middleware
- Async error wrapper for route handlers
- Consistent error response format

### 3. Validation
- Input validation middleware for all POST/PUT requests
- Type checking and required field validation

### 4. Logging
- Request/response logging middleware
- Duration tracking for performance monitoring

### 5. Scalability
- Easy to add new features without touching existing code
- Each file has a single responsibility
- Clear dependency injection pattern

## API Endpoints

### Properties
- `GET /api/properties` - Get all properties
- `GET /api/properties/:id` - Get property by ID
- `POST /api/properties` - Create new property
- `PUT /api/properties/:id` - Update property

### Tenants
- `GET /api/tenants` - Get all tenants
- `GET /api/tenants/:id` - Get tenant by ID
- `GET /api/tenants/:id/payment-status` - Get payment status
- `POST /api/tenants` - Create new tenant
- `DELETE /api/tenants/:tenantId` - Delete tenant
- `POST /api/tenants/:id/send-reminder` - Send payment reminder
- `POST /api/tenants/:id/send-confirmation` - Send payment confirmation

### Payments
- `GET /api/payments/status` - Get payment status
- `GET /api/payments/volume` - Get payment volume
- `GET /api/payments/monthly-report` - Get monthly report
- `GET /api/payments/overdue` - Get overdue payments
- `POST /api/payments/send-reminders` - Send reminders to overdue tenants

### Webhook
- `POST /api/webhook` - Process M-Pesa payment webhook

### Stats
- `GET /api/stats` - Get system statistics

## Installation

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Update .env with your configuration

# Start development server
npm run dev

# Start production server
npm start
```

## Environment Variables

- `NODE_ENV` - Environment (development/production)
- `PORT` - Server port (default: 3000)
- Firebase configuration variables
- SMS service configuration

## Testing

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

## Contributing

1. Create a feature branch
2. Make your changes
3. Write/update tests
4. Submit a pull request

## License

MIT
*/

// ============================================
// MIGRATION GUIDE
// ============================================
/*
## Migration from Old Structure to New Structure

### Step 1: Create New Folder Structure
```bash
mkdir -p src/{config,middleware,controllers,services,routes,utils}
```

### Step 2: Move Files
1. Move Firebase configuration to `src/config/firebase.js`
2. Move SMS processor to keep in root (referenced by services)
3. Create new files as shown in the restructured code

### Step 3: Update Imports
- Update all require statements to use new paths
- Use relative paths for internal modules
- Keep external dependencies as-is

### Step 4: Test Each Module
1. Test property endpoints
2. Test tenant endpoints
3. Test payment endpoints
4. Test webhook endpoint
5. Test stats endpoint

### Step 5: Deploy
1. Update deployment scripts to point to `src/server.js`
2. Ensure all environment variables are set
3. Test in staging environment
4. Deploy to production

## Benefits of New Structure

1. **Maintainability**: Each file has a clear purpose
2. **Testability**: Services can be tested independently
3. **Scalability**: Easy to add new features
4. **Readability**: Clear separation of concerns
5. **Debugging**: Easier to locate and fix issues
6. **Team Collaboration**: Multiple developers can work without conflicts
7. **Code Reuse**: Services can be reused across controllers
8. **Error Handling**: Centralized and consistent

## Next Steps

1. Add unit tests for services
2. Add integration tests for routes
3. Implement API documentation (Swagger/OpenAPI)
4. Add request rate limiting
5. Implement caching layer
6. Add database transactions for critical operations
7. Implement audit logging
8. Add API versioning (v1, v2, etc.)
*/