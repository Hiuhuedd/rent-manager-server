
// ============================================
// FILE: src/config/firebase.js
// ============================================
const { getFirestoreApp, getAuthApp } = require('../firebase');
const db = getFirestoreApp();
const auth = getAuthApp ? getAuthApp() : null;

module.exports = { db, auth, getFirestoreApp, getAuthApp };