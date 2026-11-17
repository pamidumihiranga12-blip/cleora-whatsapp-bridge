# Cleora WhatsApp Baileys Bridge — Render.com Deploy Guide

මෙම Baileys Node.js Bridge එක Render.com හෝ Railway.app මත deploy කිරීමෙන් Cleora වෙබ් අඩවියට WhatsApp AI Bot සෘජුවම සම්බන්ධ කරගත හැක.

---

## 🚀 පියවර 1: GitHub වෙත Upload කිරීම (2 Minutes)

1. [GitHub.com](https://github.com) වෙත ගොස් ඔබගේ ගිණුමට Login වන්න.
2. **"New repository"** click කර repository එකක් සාදන්න (උදාහරණයක් ලෙස: `cleora-whatsapp-bridge`).
3. මෙම `cleora_baileys_bridge` ෆෝල්ඩරයේ ඇති සියලුම files GitHub repo එකට Upload (Push) කරන්න:
   ```bash
   git init
   git add .
   git commit -m "Cleora WhatsApp Bridge"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/cleora-whatsapp-bridge.git
   git push -u origin main
   ```
   *(නැතහොත් GitHub වෙබ් අඩවියේ "Upload files" මඟින් upload කළ හැක).*

---

## 🌐 පියවර 2: Render.com හි Deploy කිරීම (3 Minutes)

1. [Render.com](https://render.com) වෙත ගොස් Login වන්න.
2. **"New +"** බොත්තම click කර **"Web Service"** තෝරන්න.
3. **"Build and deploy from a Git repository"** තෝරා ඔබ සෑදූ `cleora-whatsapp-bridge` repository එක තෝරන්න.
4. පහත විස්තර ලබා දෙන්න:
   - **Name**: `cleora-whatsapp-bridge`
   - **Region**: Singapore (Southeast Asia)
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
5. **Environment Variables** (පහත variables 2ක ඇතුළත් කරන්න):
   - `PHP_BACKEND_URL`: `https://smartzonelk.com.lk`
   - `BRIDGE_SECRET`: `smartzone_baileys_secret_2026`
6. **"Create Web Service"** click කරන්න.

---

## 🔗 පියවර 3: Cleora Admin එකට Render URL එක ලබාදීම

1. Render හි service එක deploy වූ පසු ලැබෙන URL එක (උදාහරණයක් ලෙස: `https://cleora-whatsapp-bridge.onrender.com`) copy කරගන්න.
2. Cleora වෙබ් අඩවියේ `public_html/api/wa_config.php` හි:
   ```php
   define('BAILEYS_BRIDGE_URL', 'https://cleora-whatsapp-bridge.onrender.com');
   ```
3. දැන් Cleora Admin (`/admin/whatsapp.php`) වෙත ගොස් **"QR Code එක Generate කරන්න"** click කර ඔබගේ WhatsApp එකෙන් Scan කරන්න!

---

💡 **සටහන:**
ඔබ දැනටමත් CodFlow සඳහා Render Bridge එකක් භාවිතා කරන්නේ නම් (`https://wa-bridge-293f.onrender.com`), එයටද Cleora ස්වයංක්‍රීයව සහාය දක්වන බැවින් අලුතින් Render එකක් deploy නොකර වුවද පරීක්ෂා කරගත හැක!
