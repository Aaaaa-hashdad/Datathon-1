// Sign-up profile fields shared by the /ui/ login page and the PC app:
// graduation year, major, gender, height, weight, date of birth.
// Everything is saved to the users table in Supabase when the account is created.
window.RevGymSignup = (() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function init() {
    const year = new Date().getFullYear();
    const grad = $("su-grad");
    if (grad && grad.options.length <= 1) {
      for (let y = year + 6; y >= year - 6; y--) grad.append(new Option(`${y} (Class of '${pad(y % 100)})`, String(y)));
    }
    const today = new Date();
    const dob = $("su-dob");
    if (dob) {
      dob.max = iso(new Date(today.getFullYear() - 13, today.getMonth(), today.getDate()));
      dob.min = iso(new Date(today.getFullYear() - 100, today.getMonth(), today.getDate()));
    }
  }

  /** → { data } or { error, field } */
  function read() {
    const grad = $("su-grad").value;
    const major = $("su-major").value.trim();
    const gender = $("su-gender").value;
    const ft = $("su-ft").value, inch = $("su-in").value;
    const weight = $("su-weight").value;
    const dob = $("su-dob").value;
    if (!grad) return { error: "Pick your graduation year.", field: "su-grad" };
    if (major.length < 2) return { error: "Enter your major.", field: "su-major" };
    if (!gender) return { error: "Pick a gender, or “Prefer not to say”.", field: "su-gender" };
    if (!ft || inch === "") return { error: "Enter your height.", field: "su-ft" };
    const w = Number(weight);
    if (!weight || !(w >= 50 && w <= 700)) return { error: "Enter your weight in pounds (50–700).", field: "su-weight" };
    if (!dob) return { error: "Enter your date of birth.", field: "su-dob" };
    if (dob > $("su-dob").max) return { error: "You need to be at least 13 to use RevGym.", field: "su-dob" };
    return {
      data: {
        grad_year: Number(grad),
        major,
        gender,
        height_in: Number(ft) * 12 + Number(inch),
        weight_lb: w,
        birth_date: dob,
      },
    };
  }

  /** Turn an error reply from the server into one plain sentence. */
  function errorText(body, fallback) {
    const d = body && body.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d) && d.length) {
      const m = String(d[0].msg || "").replace(/^Value error, /, "");
      const where = { grad_year: "graduation year", birth_date: "date of birth", weight_lb: "weight", height_in: "height", major: "major", gender: "gender", username: "username", password: "password" }[d[0].loc && d[0].loc[d[0].loc.length - 1]];
      return where && !/^[A-Z]/.test(m) ? `Check your ${where}: ${m}.` : m || fallback;
    }
    return fallback;
  }

  return { init, read, errorText };
})();
