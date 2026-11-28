// Replaces tiny-secp256k1's wasm_loader for the browser: instantiates the binary that wasm-bytes.js put on
// self.SECP256K1_WASM (base64), with the same random-seed import the package's browser loader provides.
const b64 = (self as unknown as { SECP256K1_WASM?: string }).SECP256K1_WASM;
if (!b64) throw new Error('wasm-bytes.js did not load');
const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const rand = {
  generateInt32() {
    const b = new Uint8Array(4);
    crypto.getRandomValues(b);
    return (b[0]! << 24) + (b[1]! << 16) + (b[2]! << 8) + b[3]!;
  },
};
const instance = new WebAssembly.Instance(new WebAssembly.Module(binary), { './rand.js': rand });
export default instance.exports;
