// Just enough DER to read one field out of a certificate the caller has already verified: find an object
// identifier by its bytes and return the value that follows it. Chip makers put what a verifier needs (firmware
// levels, a platform family, a chip id) in private extensions that Node's X509Certificate does not expose.

/** The value that follows the object identifier `oidBody` (hex, without tag and length), if its tag is `tag`. */
export function valueAfter(raw: Buffer, oidBody: string, tag: number): Buffer | null {
  const id = Buffer.from(`06${(oidBody.length / 2).toString(16).padStart(2, '0')}${oidBody}`, 'hex');
  const at = raw.indexOf(id);
  if (at < 0) return null;
  let o = at + id.length;
  // An extension may carry a "critical" flag (BOOLEAN) between its id and its value.
  if (raw[o] === 0x01 && raw[o + 1] === 0x01) o += 3;
  if (raw[o] !== tag) return null;
  let len = raw[o + 1];
  o += 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = Number(BigInt(`0x${raw.subarray(o, o + n).toString('hex') || '0'}`));
    o += n;
  }
  return o + len <= raw.length ? raw.subarray(o, o + len) : null;
}

/** An unsigned DER INTEGER's content as a number. */
export const derInt = (b: Buffer) => Number(BigInt(`0x${b.toString('hex') || '0'}`));
