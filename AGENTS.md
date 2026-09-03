# ikas Product Health Checker Agent Guide

<!-- ortak-ajan-kurallari:v1 -->
## Ortak Ajan Kuralları (tüm projeler)

Bu bölüm Emre'nin bütün projelerinde aynıdır. Proje kuralları bu bölümle çelişirse daha kısıtlayıcı olan uygulanır.

- `AGENTS.md` bu depodaki tek kural kaynağıdır. `CLAUDE.md` yalnızca `AGENTS.md` dosyasına yönlendiren bir router'dır; oraya kural, standart veya proje bilgisi yazılmaz.
- Uygulamaya başlamadan önce `understanding-check-before-implementation` skill'i zorunludur: hedef, kapsam, varsayımlar, en fazla üç engelleyici soru ve ilk adım sunulur; `approved` veya `defaults` yanıtı gelmeden dosya, kod, veri, yapılandırma veya üretim davranışı değiştirilmez. Yalnızca salt okuma, saf açıklama ve tek satırlık düşük riskli düzeltmeler bu kapıdan muaftır.
- Çıktı kısa ve kanıtlıdır. Tamamlanma beyanı yalnızca güncel araç kanıtıyla yapılır; bir komutu başlatmak geçtiğinin kanıtı değildir.
- Tekil dil kullanılır ("inceledim", "düzeltildi"). Birinci çoğul şahıs ("yaptık", "bizim", "elimizdeki") kullanılmaz.
- Üretilen hiçbir çıktıda (commit, PR, kod, yorum, doküman) yapay zekâ veya asistan adı geçmez; `Co-Authored-By` türü imzalar eklenmez.
- Uzun tire (U+2014) kullanılmaz; virgül, nokta veya ASCII tire tercih edilir.
- Teslimat şablonları ("Bu iş tamamlandı" bloğu, preview/PR footer'ı vb.) yalnızca teslim edilen bir iş için kullanılır. Soru-cevap turlarında, durum kontrollerinde ve zamanlanmış otomasyon koşularında kullanılmaz.
- Her değişiklik ana dala (`main`, `preview`) doğrudan değil, ayrı bir branch ve ready-for-review PR ile gider; draft PR açılmaz. Merge ve üretim yayını için proje kuralı geçerlidir; proje kuralı yoksa merge için Emre onayı gerekir.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
