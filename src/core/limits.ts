/** Ayristiricilara gecirilen guvenlik ve kirpma sinirlari. Tumu kullanici ayarindan gelir. */
export interface ParseLimits {
    /** OOXML kapsayicisindan acilabilecek toplam bayt (zip bomb korumasi). */
    maxTotalUncompressed: number;
    /** Girdi basina acilmis/sikistirilmis oran ust siniri (zip bomb korumasi). */
    maxRatio: number;
    /** Sayfa basina gosterilecek en fazla satir. */
    maxRows: number;
    /** Sayfa basina gosterilecek en fazla sutun. */
    maxColumns: number;
    csvDelimiter: 'auto' | 'comma' | 'semicolon' | 'tab' | 'pipe';
    showImages: boolean;
}

/** Tek bir gomulu gorselin ust siniri - buyuk taramalar webview'i kilitlemesin. */
export const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

/** Bir belgeden cikarilacak toplam gorsel baytinin ust siniri. */
export const MAX_TOTAL_IMAGE_BYTES = 192 * 1024 * 1024;

/** Bir belgeden cikarilacak en fazla gorsel sayisi. */
export const MAX_IMAGE_COUNT = 2000;
