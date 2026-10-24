import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}
const encodedPassword = /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/u;

export function isAdminPasswordHash(value: string): boolean {
  return encodedPassword.test(value);
}

export async function hashAdminPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1024) {
    throw new Error("Administrator password must contain 12–1024 characters");
  }
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return `scrypt:${salt}:${key.toString("hex")}`;
}

export async function verifyAdminPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const parts = encodedPassword.exec(hash);
  if (!parts || password.length > 1024) return false;
  const key = await derive(password, parts[1]);
  return timingSafeEqual(key, Buffer.from(parts[2], "hex"));
}
