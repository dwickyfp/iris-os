export function hasExplicitLearningControlIntent(text: string) {
  return (
    /\b(learning|belajar|pembelajaran|memory|memori)\b/i.test(text) &&
    /\b(aktifkan|matikan|ubah|atur|setel|enable|disable|retention|retensi|scope|kategori|autonomy|otonomi)\b/i.test(
      text,
    )
  );
}

export function hasExplicitAutomationIntent(text: string) {
  return /\b(automation|otomasi|jadwal|schedule|cron|setiap|tiap|pause|jeda|arsip|archive|trigger|jalankan)\b/i.test(
    text,
  );
}
