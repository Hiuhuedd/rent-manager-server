  
// ============================================
// FILE: src/config/firebase.js
// ============================================
const { getFirestoreApp } = require('../../firebase');
const db = getFirestoreApp();

module.exports = { db };