// Firebase Web App - Project: presensinaker
export const firebaseConfig = {
  apiKey: "AIzaSyAJaIGLVINXPne2VdNR8U-EiQabTUhMgjw",
  authDomain: "presensinaker.firebaseapp.com",
  projectId: "presensinaker",
  storageBucket: "presensinaker.firebasestorage.app",
  messagingSenderId: "874794884720",
  appId: "1:874794884720:web:8a8e6b854b16cd9e611eb5"
};

// Admin yang diizinkan membuka panel admin.
// Harus sama dengan email pada firestore.rules dan akun Firebase Authentication.
export const ADMIN_EMAILS = [
  "muh.zaini1718@gmail.com"
];

// Kotabaru/Banjarmasin menggunakan WITA.
export const APP_TIME_ZONE = "Asia/Makassar";

// Struktur penyimpanan V3:
// attendance/2026-09                     -> metadata periode
// attendance/2026-09/employees/{sha256} -> data seorang pegawai
// settings/current                       -> periode aktif
export const ATTENDANCE_COLLECTION = "attendance";
export const EMPLOYEE_SUBCOLLECTION = "employees";
export const CURRENT_SETTINGS_DOC_PATH = "settings/current";
