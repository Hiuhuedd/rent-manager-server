const { getAuthApp, getFirestoreApp } = require('../config/firebase');
const { createUserWithEmailAndPassword, signInWithEmailAndPassword } = require('firebase/auth');
const { doc, setDoc, updateDoc, getDoc } = require('firebase/firestore');

const auth = getAuthApp();
const db = getFirestoreApp();

const authController = {
    // Register a new agency
    register: async (req, res) => {
        try {
            const { email, password, agencyName } = req.body;

            if (!email || !password || !agencyName) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            // Create user in Firebase Auth
            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            // Create initial agency document
            const agencyData = {
                email: user.email,
                agencyName: agencyName,
                createdAt: new Date().toISOString(),
                onboardingCompleted: false,
                role: 'admin'
            };

            await setDoc(doc(db, 'agencies', user.uid), agencyData);

            res.status(201).json({
                message: 'Agency registered successfully',
                user: {
                    uid: user.uid,
                    email: user.email,
                    onboardingCompleted: false
                }
            });
        } catch (error) {
            console.error('Registration error:', error);
            let errorMessage = 'Registration failed';
            if (error.code === 'auth/email-already-in-use') {
                errorMessage = 'Email already in use';
            }
            res.status(400).json({ error: errorMessage, details: error.message });
        }
    },

    // Login
    login: async (req, res) => {
        try {
            const { email, password } = req.body;

            if (!email || !password) {
                return res.status(400).json({ error: 'Email and password required' });
            }

            const userCredential = await signInWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            // Fetch agency details to check onboarding status
            const agencyDoc = await getDoc(doc(db, 'agencies', user.uid));

            let onboardingCompleted = false;
            let agencyName = '';

            if (agencyDoc.exists()) {
                const data = agencyDoc.data();
                onboardingCompleted = data.onboardingCompleted || false;
                agencyName = data.agencyName || '';
            }

            // In a real production app, you would issue a JWT here. 
            // For this simplified proxy, we'll return the firebase UID or a session token if we had one.
            // We'll rely on the frontend to store this state.

            res.status(200).json({
                message: 'Login successful',
                user: {
                    uid: user.uid,
                    email: user.email,
                    agencyName,
                    onboardingCompleted
                }
            });
        } catch (error) {
            console.error('Login error:', error);
            let errorMessage = 'Login failed';
            if (error.code === 'auth/invalid-credential') {
                errorMessage = 'Invalid email or password';
            }
            res.status(401).json({ error: errorMessage });
        }
    },

    // Complete Onboarding
    completeOnboarding: async (req, res) => {
        try {
            const { uid, onboardingData } = req.body;

            if (!uid || !onboardingData) {
                return res.status(400).json({ error: 'Missing data' });
            }

            const agencyRef = doc(db, 'agencies', uid);

            await updateDoc(agencyRef, {
                ...onboardingData,
                onboardingCompleted: true,
                updatedAt: new Date().toISOString()
            });

            res.status(200).json({ message: 'Onboarding completed successfully' });
        } catch (error) {
            console.error('Onboarding update error:', error);
            res.status(500).json({ error: 'Failed to save onboarding data' });
        }
    }
};

module.exports = authController;
