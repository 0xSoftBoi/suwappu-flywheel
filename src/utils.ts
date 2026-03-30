export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Error: ${name} not set`);
    if (name === "SUWAPPU_API_KEY")
      console.error('  Get one: curl -X POST https://api.suwappu.bot/v1/agent/register -H "Content-Type: application/json" -d \'{"name":"my-agent"}\'');
    process.exit(1);
  }
  return val;
}

export function formatUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function log(strategy: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${strategy}] ${msg}`);
}

export function logJson(data: Record<string, unknown>) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...data }));
}
