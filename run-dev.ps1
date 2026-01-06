# PowerShell script to run wa-bridge in dev mode
# This ensures we use the local tsx installation

$env:NODE_ENV = "development"
npx tsx watch src/index.ts



