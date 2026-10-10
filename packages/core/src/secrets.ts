const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "AWS アクセスキー", re: /AKIA[0-9A-Z]{16}/ },
  { name: "GitHub トークン", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "GitHub fine-grained トークン", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "OpenAI 形式キー", re: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: "Anthropic キー", re: /sk-ant-[A-Za-z0-9_-]+/ },
  { name: "Slack トークン", re: /xox[baprs]-[A-Za-z0-9-]+/ },
  { name: "秘密鍵ブロック", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Google API キー", re: /AIza[0-9A-Za-z_-]{35}/ },
  {
    name: "汎用シークレット代入",
    re: /(api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{16,}/i,
  },
];

export function findSecrets(text: string): string[] {
  return PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}
