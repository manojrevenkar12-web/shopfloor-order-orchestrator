const int = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
export const fmtInt = (x: number) => int.format(x);
export const fmtNum = (x: number, digits: number) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(x);
export const change = (x: number, base: number) => (base === 0 ? 0 : (100 * (x - base)) / base);
export const fmtPct = (x: number) => `${x > 0 ? "+" : ""}${int.format(x)} %`;
