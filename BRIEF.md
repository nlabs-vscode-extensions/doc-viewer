# doc-viewer - nLabs Document Viewer

Bizim urunumuz. Kaldirilan ucuncu-parti eklentilerin (`cweijan.vscode-office`,
`tomoki1207.pdf`) yerine gecer. Referans notlari ayri klasorlerde durur:
`../office-viewer/BRIEF.md`, `../pdf-viewer/BRIEF.md` (kod yok, yalniz not).

## Degismez kural: TAM SIFIR BAGIMLILIK

Runtime bagimliligi YOKTUR ve eklenmez. `pdfjs-dist`, `SheetJS/xlsx`, `docx-preview`,
`pptx-preview` KULLANILMAZ. `devDependencies` yalniz dort kalemdir: `@types/node`,
`@types/vscode`, `typescript`, `@vscode/vsce`.

Bir bicim destegi eklenecekse ayni kuralla degerlendirilir. Kutuphane onerisi
geldiginde once bu dosya ve hafiza notu (`doc-viewer-proje`) okunur.

**Bunun kabul edilmis bedeli:** PDF'te piksel-dogru sayfa render YOK. PDF metin +
gomulu gorsel + yapi (sayfa/meta/outline) seviyesinde kalir. Bu bir eksiklik degil,
saldiri yuzeyini kapatmak icin verilmis karardir.

## Neyin nerede oldugu

| Yol | Ne yapar |
|---|---|
| `src/zip/zip.ts` | ZIP okuyucu: merkezi dizin, ZIP64, `zlib.inflateRawSync`. Zip-bomb ve yol kacisi korumasi burada. |
| `src/xml/xml.ts` | Mini XML ayristirici. DTD/varlik cozumleme BILEREK yok (XXE ve billion-laughs kapali). |
| `src/formats/ooxml.ts` | Word/Excel ortak: kapsayici acma, iliski (rels) cozme, gomulu gorsel toplama. |
| `src/formats/docx.ts` | WordprocessingML -> blok modeli (baslik, liste, tablo, run bicimleri). |
| `src/formats/xlsx.ts` | SpreadsheetML -> tablo modeli (paylasilan dize, stil, sayi/tarih bicimi, birlesim). |
| `src/formats/csv.ts` | CSV/TSV: ayrac ve baslik sezme. Kodlama sezme `src/core/text.ts`'te. |
| `src/formats/pdf/` | PDF yigini: `lexer` (sozdizimi), `filters` (Flate/LZW/A85/RL + predictor), `document` (nesne deposu), `fonts` + `encoding` (kod -> Unicode), `content` (icerik akisi), `images` (XObject -> PNG/JPEG), `index` (birlestirme). |
| `src/core/png.ts` | Kendi PNG kodlayicimiz. Ham PDF ornekleri ve marketplace ikonu bununla uretilir. |
| `src/viewers/provider.ts` | CustomReadonlyEditorProvider - dort viewType tek saglayici. |
| `media/viewer.js` | Webview arayuzu. **`innerHTML` YASAK** - her metin `textContent` ile yazilir. |
| `scripts/smoke.mjs` | Ayristiricilari gercek dosyalara karsi calistiran dev araci. |
| `scripts/make-icon.mjs` | `images/icon.png` uretir (kendi PNG kodlayicimizla). |

## PDF nesne deposu neden "tarama" ile calisiyor

Gercek dunyadaki PDF'lerin buyuk bolumu artimli guncelleme, yanlis ofset veya kesik
xref tasiyor. `document.ts` xref tablosuna guvenmek yerine dosyayi tarayip tum
`N G obj` basliklarini buluyor, sonra `/Type /ObjStm` akislarini aciyor. 40 dosyalik
gercek korpusta 40/40 gecti; xref merkezli bir okuyucu bu oranini tutturamazdi.

## Ev stili notlari

- Kaynak dosyalar **saf ASCII**. Turkce/Almanca/Fransizca UI metinleri
  `src/core/i18n.ts` icinde unicode kacisi (`\u00fc`) ile yazilir; calisma aninda
  dogru karakter cikar. Encoding katmani cok-baytli karakterleri bozabildigi icin.
- pnpm kullanilir. `pnpm run compile` -> `out/`, `pnpm run package` -> `.vsix`.
- F5 ile Extension Development Host acilir (`.vscode/launch.json`).

## Test

```powershell
pnpm run compile
node scripts/smoke.mjs --dir "<belge klasoru>"
```

Ilgili hafiza: `doc-viewer-proje`, `agent-panel-proje`, `dokuman-tam-inceleme-gorsel-dahil`.
