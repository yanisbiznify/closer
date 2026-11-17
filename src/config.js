// Configuration lue depuis les variables d'environnement (Railway → Variables)
const crypto = require("crypto");

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);

const config = {
  port: Number(env("PORT", 3000)),
  databaseUrl: env("DATABASE_URL"),
  pgSsl: env("PGSSL", "false") === "true",

  appPassword: env("APP_PASSWORD"),
  sessionSecret: env("SESSION_SECRET"),
  webhookSecret: env("WEBHOOK_SECRET"),

  ghlApiKey: env("GHL_API_KEY"),
  ghlLocationId: env("GHL_LOCATION_ID"),

  deepgramApiKey: env("DEEPGRAM_API_KEY"),
  deepgramModel: env("DEEPGRAM_MODEL", "nova-3"),

  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  anthropicModel: env("ANTHROPIC_MODEL", "claude-sonnet-5-5"),

  syncIntervalMin: Number(env("SYNC_INTERVAL_MIN", 10)),

  // Dialer (Twilio)
  twilioSid: env("TWILIO_ACCOUNT_SID"),
  twilioToken: env("TWILIO_AUTH_TOKEN"),
  twilioCallerId: env("TWILIO_CALLER_ID"),
  publicUrl: env("PUBLIC_URL"),
  twilioSmsFrom: env("TWILIO_SMS_FROM"), // numéro d'envoi des SMS, si différent du numéro d'appel

  // Agenda (Google)
  googleClientId: env("GOOGLE_CLIENT_ID"),
  googleClientSecret: env("GOOGLE_CLIENT_SECRET"),

  // Email pro (Resend) : envoi depuis ton adresse sur ton domaine
  resendApiKey: env("RESEND_API_KEY"),
  emailFrom: env("EMAIL_FROM"), // ex. contact@biznify.pro

  // Paiements (Stripe)
  stripeSecretKey: env("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: env("STRIPE_WEBHOOK_SECRET"),
};

// Secret de session : dérivé du mot de passe si non fourni
if (!config.sessionSecret && config.appPassword) {
  config.sessionSecret = crypto.createHash("sha256").update("closer:" + config.appPassword).digest("hex");
}

config.missing = () =>
  ["DATABASE_URL", "APP_PASSWORD", "GHL_API_KEY", "GHL_LOCATION_ID", "DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY"].filter(
    (k) => !process.env[k]
  );

module.exports = config;
