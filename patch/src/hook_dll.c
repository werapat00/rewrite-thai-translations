#include <windows.h>
#include <wchar.h>
#include "MinHook.h"
#include "patch_config.h"

static wchar_t g_selfDir[MAX_PATH];

static HANDLE(WINAPI *TrueCreateFileW)(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES,
                                       DWORD, DWORD, HANDLE) = NULL;

static BOOL(WINAPI *TrueSetWindowTextW)(HWND, LPCWSTR) = NULL;

static HFONT(WINAPI *TrueCreateFontIndirectW)(const LOGFONTW *) = NULL;

static HFONT(WINAPI *TrueCreateFontW)(int, int, int, int, int, DWORD, DWORD, DWORD, DWORD,
                                      DWORD, DWORD, DWORD, DWORD, LPCWSTR) = NULL;

static DWORD(WINAPI *TrueGetGlyphOutlineW)(HDC, UINT, UINT, LPGLYPHMETRICS, DWORD, LPVOID,
                                           const MAT2 *) = NULL;

/* Siglus Engine rasterizes its own glyph cache per-character via GetGlyphOutlineW
   instead of drawing text through TextOutW/ExtTextOutW, so the substitution has
   to happen here rather than at a string-level text-draw hook. */
// static UINT RemapGlyphChar(UINT uChar) {
//     return uChar == (UINT)L'พ' ? (UINT)L'ฟ' : uChar;
// }

static const wchar_t *BaseNameW(const wchar_t *path) {
    const wchar_t *base = path;
    for (const wchar_t *p = path; *p; p++) {
        if (*p == L'\\' || *p == L'/') {
            base = p + 1;
        }
    }
    return base;
}

/* Resolves a FILE_MAPPINGS entry against the folder the hook DLL itself lives in,
   so redirects work regardless of the game's own working directory. */
static BOOL ResolveRedirect(const wchar_t *fileName, wchar_t *out, DWORD outLen) {
    const wchar_t *base = BaseNameW(fileName);
    for (size_t i = 0; i < FILE_MAPPINGS_COUNT; i++) {
        if (_wcsicmp(FILE_MAPPINGS[i].from, base) == 0) {
            _snwprintf(out, outLen, L"%s\\%s", g_selfDir, FILE_MAPPINGS[i].to);
            out[outLen - 1] = L'\0';
            return TRUE;
        }
    }
    return FALSE;
}

static HANDLE WINAPI HookedCreateFileW(LPCWSTR lpFileName, DWORD dwDesiredAccess,
                                        DWORD dwShareMode,
                                        LPSECURITY_ATTRIBUTES lpSecurityAttributes,
                                        DWORD dwCreationDisposition,
                                        DWORD dwFlagsAndAttributes, HANDLE hTemplateFile) {
    wchar_t redirected[MAX_PATH];
    if (lpFileName && ResolveRedirect(lpFileName, redirected, MAX_PATH)) {
        lpFileName = redirected;
    }
    return TrueCreateFileW(lpFileName, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
                            dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
}

static BOOL WINAPI HookedSetWindowTextW(HWND hWnd, LPCWSTR lpString) {
    (void)lpString;
    return TrueSetWindowTextW(hWnd, WINDOW_TITLE);
}

static HFONT WINAPI HookedCreateFontIndirectW(const LOGFONTW *lplf) {
    LOGFONTW lf = *lplf;
    wcsncpy(lf.lfFaceName, FONT_NAME, LF_FACESIZE - 1);
    lf.lfFaceName[LF_FACESIZE - 1] = L'\0';
    return TrueCreateFontIndirectW(&lf);
}

static HFONT WINAPI HookedCreateFontW(int cHeight, int cWidth, int cEscapement,
                                      int cOrientation, int cWeight, DWORD bItalic,
                                      DWORD bUnderline, DWORD bStrikeOut, DWORD iCharSet,
                                      DWORD iOutPrecision, DWORD iClipPrecision,
                                      DWORD iQuality, DWORD iPitchAndFamily,
                                      LPCWSTR pszFaceName) {
    (void)pszFaceName;
    return TrueCreateFontW(cHeight, cWidth, cEscapement, cOrientation, cWeight, bItalic,
                           bUnderline, bStrikeOut, iCharSet, iOutPrecision, iClipPrecision,
                           iQuality, iPitchAndFamily, FONT_NAME);
}

static DWORD WINAPI HookedGetGlyphOutlineW(HDC hdc, UINT uChar, UINT uFormat,
                                           LPGLYPHMETRICS lpgm, DWORD cbBuffer,
                                           LPVOID lpvBuffer, const MAT2 *lpmat2) {
    // if (!(uFormat & GGO_GLYPH_INDEX)) {
    //     uChar = RemapGlyphChar(uChar);
    // }
    return TrueGetGlyphOutlineW(hdc, uChar, uFormat, lpgm, cbBuffer, lpvBuffer, lpmat2);
}

static void InitSelfDir(HINSTANCE hinstDLL) {
    wchar_t path[MAX_PATH];
    GetModuleFileNameW(hinstDLL, path, MAX_PATH);
    wchar_t *lastSlash = wcsrchr(path, L'\\');
    if (lastSlash) {
        *lastSlash = L'\0';
    }
    wcsncpy(g_selfDir, path, MAX_PATH - 1);
}

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved) {
    (void)lpvReserved;

    if (fdwReason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinstDLL);
        InitSelfDir(hinstDLL);

        if (MH_Initialize() != MH_OK) {
            return TRUE;
        }
        if (MH_CreateHook((LPVOID)CreateFileW, (LPVOID)HookedCreateFileW,
                           (LPVOID *)&TrueCreateFileW) == MH_OK) {
            MH_EnableHook((LPVOID)CreateFileW);
        }
        if (MH_CreateHook((LPVOID)SetWindowTextW, (LPVOID)HookedSetWindowTextW,
                           (LPVOID *)&TrueSetWindowTextW) == MH_OK) {
            MH_EnableHook((LPVOID)SetWindowTextW);
        }
        if (MH_CreateHook((LPVOID)CreateFontIndirectW, (LPVOID)HookedCreateFontIndirectW,
                           (LPVOID *)&TrueCreateFontIndirectW) == MH_OK) {
            MH_EnableHook((LPVOID)CreateFontIndirectW);
        }
        if (MH_CreateHook((LPVOID)CreateFontW, (LPVOID)HookedCreateFontW,
                           (LPVOID *)&TrueCreateFontW) == MH_OK) {
            MH_EnableHook((LPVOID)CreateFontW);
        }
        if (MH_CreateHook((LPVOID)GetGlyphOutlineW, (LPVOID)HookedGetGlyphOutlineW,
                           (LPVOID *)&TrueGetGlyphOutlineW) == MH_OK) {
            MH_EnableHook((LPVOID)GetGlyphOutlineW);
        }
    } else if (fdwReason == DLL_PROCESS_DETACH) {
        MH_Uninitialize();
    }

    return TRUE;
}
