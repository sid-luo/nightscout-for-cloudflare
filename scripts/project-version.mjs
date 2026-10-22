/** Keep the public calendar label tied to npm's calendar SemVer metadata. */
export function displayProjectVersion({ version, nscfVersion }) {
  if (nscfVersion === undefined) return version;
  const calendar = typeof version === "string"
    ? /^([1-9]\d{3})\.([1-9]\d?)\.([1-9]\d?)(-beta)?$/.exec(version) : null;
  if (calendar !== null) {
    const [, year, month, day, suffix = ""] = calendar;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    const expected = `${year}${month.padStart(2, "0")}${day.padStart(2, "0")}${suffix}`;
    if (date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1
      && date.getUTCDate() === Number(day) && nscfVersion === expected) return nscfVersion;
  }
  throw new Error("nscfVersion must match a valid YYYY.M.D[-beta] package version as YYYYMMDD[-beta]");
}
