# Diario delle calorie: offline app

The folder contains the whole app:

| File | What it does |
|---|---|
| `index.html` | The app: diary, dashboard, helper, backup, AI features |
| `manifest.webmanifest` | Name, icon and full-screen mode when installed |
| `sw.js` | Makes the app work offline |
| `icons/` | Home-screen icons |

## 1. Put it online (once, about 10 minutes, free)

**GitHub Pages**
1. Create a free account on github.com.
2. Click **+** (top right) → **New repository**. Name it `diario`, leave it **Public**, click **Create repository**.
3. On the next page click **uploading an existing file**. Drag in **everything inside this folder**: `index.html`, `manifest.webmanifest`, `sw.js`, `README.md` and the `icons` folder. Click **Commit changes**.
4. Go to **Settings** → **Pages**. Under "Build and deployment" choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
5. After 1–2 minutes the app is at `https://YOUR-USERNAME.github.io/diario/`.

The repository only holds the app's code. Your food data never goes there: it stays on your phone.

**Alternative: Netlify.** Create a free account on netlify.com, open **app.netlify.com/drop** and drag this whole folder onto the page.

## 2. Install it on your phone

- **iPhone:** open the address in **Safari** → **Share** → **Add to Home Screen**.
- **Android:** open it in **Chrome** → **Install app** (or ⋮ menu → **Install app**).

Open it once with internet so it can save itself for offline use. After that it works in airplane mode too.

## 3. Bring over your data from the Claude version

1. In the Claude version: **Backup dei dati** → **Esporta backup** and save the file.
2. In the app: **Backup dei dati** → **Importa** → choose that file → **Importa**.

## 4. Turn on the AI features (optional)

1. On **console.anthropic.com**, create an account, add some credit, then go to **API keys** → **Create key**.
2. Set a low monthly spend limit (for example 5 €) under **Limits**.
3. In the app: **Funzioni AI (Claude)** → paste the key → **Salva e prova**.

The key is stored only on your phone and sent only to Anthropic. AI features need internet; everything else works offline.

## Backups

Your data lives only on the phone. The app reminds you every 14 days. Use **Esporta backup** and keep the file in iCloud, Google Drive or email. If you delete the app, your data goes with it unless you have a backup.

## Updating the app

When you get new files, upload them to the same place, replacing the old ones. The app shows "È pronta una nuova versione": tap **Aggiorna**. Your data stays as it is.
