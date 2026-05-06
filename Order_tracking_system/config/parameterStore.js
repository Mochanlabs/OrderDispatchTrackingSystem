const { SSMClient, GetParametersCommand } = require("@aws-sdk/client-ssm");

async function loadParameters() {
  // Load .env first to check LOCAL_DEV flag
  require("dotenv").config();

  // ============================================
  // PRIORITY 1: Local Development
  // Set LOCAL_DEV=true to use .env file
  // ============================================
  if (process.env.LOCAL_DEV === "true") {
    console.log("✓ Loading from .env (LOCAL DEVELOPMENT)");
    return;
  }

  const client = new SSMClient({ region: process.env.AWS_REGION || "ap-south-1" });

  // ============================================
  // PRIORITY 2 & 3: AWS EB (Parameter Store)
  // NODE_ENV=development → /odts/dev/*
  // NODE_ENV=production  → /odts/prod/*
  // ============================================
  try {
    const paramEnv = process.env.PARAM_ENV || "dev";
    const nodeEnv = process.env.NODE_ENV || "development";

    console.log(`✓ Loading parameters from AWS Parameter Store (/odts/${paramEnv}/)`);

    const allParams = [
      `/odts/${paramEnv}/DB_HOST`,
      `/odts/${paramEnv}/DB_PORT`,
      `/odts/${paramEnv}/DB_USER`,
      `/odts/${paramEnv}/DB_PASSWORD`,
      `/odts/${paramEnv}/DB_NAME`,
      `/odts/${paramEnv}/DB_SSL`,
      `/odts/${paramEnv}/DB_SSL_REJECT_UNAUTHORIZED`,
      `/odts/${paramEnv}/SESSION_SECRET`,
      `/odts/${paramEnv}/PORT`,
      `/odts/${paramEnv}/S3_BUCKET`,
      `/odts/${paramEnv}/FIREBASE_API_KEY`,
      `/odts/${paramEnv}/FIREBASE_AUTH_DOMAIN`,
      `/odts/${paramEnv}/FIREBASE_DATABASE_URL`,
      `/odts/${paramEnv}/FIREBASE_PROJECT_ID`,
    ];

    // AWS SSM GetParameters has a max of 10 parameters per call
    // Split into batches
    const batchSize = 10;
    const batches = [];
    for (let i = 0; i < allParams.length; i += batchSize) {
      batches.push(allParams.slice(i, i + batchSize));
    }

    let totalInvalidParams = [];

    for (const batch of batches) {
      const command = new GetParametersCommand({
        Names: batch,
        WithDecryption: true,
      });

      const response = await client.send(command);

      response.Parameters.forEach(param => {
        const key = param.Name.split("/").pop();
        process.env[key] = param.Value;
      });

      // Track all invalid parameters
      if (response.InvalidParameters?.length > 0) {
        totalInvalidParams = totalInvalidParams.concat(response.InvalidParameters);
      }
    }

    // Check if any critical (non-Firebase) parameters are missing
    const criticalInvalid = totalInvalidParams.filter(p => !p.includes('FIREBASE'));
    const firebaseInvalid = totalInvalidParams.filter(p => p.includes('FIREBASE'));

    if (criticalInvalid.length > 0) {
      console.error("❌ Missing critical parameters:", criticalInvalid);
      throw new Error(`Missing parameters: ${criticalInvalid.join(", ")}`);
    }

    if (firebaseInvalid.length > 0) {
      console.warn("⚠️ Firebase parameters missing (live tracking disabled):", firebaseInvalid);
    }

    const sslInvalid = totalInvalidParams.filter(p => p.includes('DB_SSL'));
    const loadedCount = allParams.length - firebaseInvalid.length - sslInvalid.length;

    if (sslInvalid.length > 0) {
      console.warn("⚠️ DB_SSL parameters missing (defaulting to unencrypted):", sslInvalid);
    }

    console.log(`✓ Loaded ${loadedCount}/${allParams.length} parameters (NODE_ENV=${nodeEnv})`);
  } catch (error) {
    console.error("❌ Failed to load parameters:", error.message);
    process.exit(1);
  }
}

module.exports = { loadParameters };
