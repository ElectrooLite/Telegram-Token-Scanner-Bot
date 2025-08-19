# Telegram-Token-Scanner-Bot
Telegram token security scanner bot

# Sentora Scanner

A Solana scanner bot that monitors newly launched tokens and their holders in real time, sending updates to Telegram.  
Built with **Node.js**, **TypeScript**, **Telegraf**, and **@solana/web3.js**.

---

## ✨ Features
- scan solana tokens in one message
- show token information such as age, mc, liq, etc.
- track dev wallet holdings
- check if dexscreener is paid
- check top holders and potential bundles
- Simple cache system to prevent duplicate spam

---

## 🧱 Tech Stack
- Node.js + TypeScript
- Telegraf (Telegram Bot API)
- @solana/web3.js, @solana/spl-token
- Optional: Helius RPC / APIs for faster data

---

## ✅ Requirements
- **Node.js 18+** (LTS recommended)
- **npm** or **pnpm**/**yarn**
- A **Telegram bot token** from [@BotFather](https://t.me/BotFather)
- A **Solana RPC URL** (public or paid)
- A **Helius API key**
- A **Alchemy API key**

---

## ✨ Use Case
- run /soul <token-address> in Telegram

---

## 📦 Installation

```bash
git clone https://github.com/your-username/sentora-scanner.git
cd sentora-scanner
npm install
