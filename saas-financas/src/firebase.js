// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBPOx6YueTyEZaOWUNeoZwP0AU3UEk9jBM",
  authDomain: "financeiro-saas-7bcdd.firebaseapp.com",
  projectId: "financeiro-saas-7bcdd",
  storageBucket: "financeiro-saas-7bcdd.firebasestorage.app",
  messagingSenderId: "576839950849",
  appId: "1:576839950849:web:9fa2996975e3b1055e9600",
  measurementId: "G-33HHE1PSPD"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);