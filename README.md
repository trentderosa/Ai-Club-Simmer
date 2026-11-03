# Simmer

Learn to cook, one dish at a time. JMU AI Club semester project. See [PRD.md](PRD.md) for requirements.

## Run it

**AI server** (on the laptop running Ollama):
```sh
cd ai-server
cp .env.example .env      # fill in keys
npm install
npm run dev               # http://<laptop-ip>:8787/health
```
Ollama must be running with the model in `OLLAMA_MODEL` pulled (default `qwen3.5:9b`).

**App:**
```sh
cd app
cp .env.example .env.local   # Supabase URL/anon key, AI server URL
npm install
npx expo start               # scan the QR code with Expo Go
```
Phones must be on the same Wi-Fi as the AI-server laptop, or use a tunnel (ngrok or Cloudflare Tunnel) and put that URL in `EXPO_PUBLIC_AI_SERVER_URL`.
