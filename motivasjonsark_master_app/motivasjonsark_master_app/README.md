# Motivasjonsark – Master App
Sentral tjeneste for å motta, lagre, vise, eksportere og videresende svar.

## Kom i gang
```bash
npm install
cp .env.example .env   # rediger ADMIN_TOKEN, ev. SMTP_*
npm run dev            # http://localhost:4000
```

## Endepunkter
- `POST /submit` – offentlig; bruk av web-appen for å sende inn svar.
  ```json
  {
    "answers": { "Spørsmål": "Svar", "...": "..." },
    "metadata": "Navn/dato (valgfritt)",
    "email": "valgfritt",
    "source": "web"
  }
  ```

- `GET /admin` – dashboard (krever admin token når UI kaller API)
- `GET /api/responses` – liste (admin token)
- `GET /api/export.csv` – eksport (admin token)
- `POST /api/responses/:id/forward` – videresend per e-post (krever SMTP + admin token)

## Sikkerhet
- Sett en sterk `ADMIN_TOKEN` i `.env` og begrens `CORS_ORIGIN` i produksjon.
