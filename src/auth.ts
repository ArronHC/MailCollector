import crypto from "node:crypto";

const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const PASSWORD_KEY_LENGTH = 64;

function derivePassword(password: string, salt: Buffer, cost = SCRYPT_COST, blockSize = SCRYPT_BLOCK_SIZE, parallelization = SCRYPT_PARALLELIZATION): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, PASSWORD_KEY_LENGTH, { N: cost, r: blockSize, p: parallelization, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function normalizeEmail(email: string): string {
  return email.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const digest = await derivePassword(password, salt);
  return ["scrypt", SCRYPT_COST, SCRYPT_BLOCK_SIZE, SCRYPT_PARALLELIZATION, salt.toString("base64url"), digest.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, costText, blockSizeText, parallelizationText, saltText, digestText] = encoded.split("$");
  if (algorithm !== "scrypt" || !costText || !blockSizeText || !parallelizationText || !saltText || !digestText) return false;
  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelization)) return false;
  try {
    const expected = Buffer.from(digestText, "base64url");
    const actual = await derivePassword(password, Buffer.from(saltText, "base64url"), cost, blockSize, parallelization);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function createSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function readCookie(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) return "";
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}
