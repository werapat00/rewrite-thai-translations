#include <windows.h>
#include <wchar.h>
#include "patch_config.h"

static void GetSelfDir(wchar_t *out, DWORD outLen) {
    wchar_t path[MAX_PATH];
    GetModuleFileNameW(NULL, path, MAX_PATH);
    wchar_t *lastSlash = wcsrchr(path, L'\\');
    if (lastSlash) {
        *lastSlash = L'\0';
    }
    wcsncpy(out, path, outLen - 1);
    out[outLen - 1] = L'\0';
}

static BOOL InjectDll(HANDLE hProcess, const wchar_t *dllPath) {
    SIZE_T sizeBytes = (wcslen(dllPath) + 1) * sizeof(wchar_t);
    LPVOID remoteMem =
        VirtualAllocEx(hProcess, NULL, sizeBytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remoteMem) {
        return FALSE;
    }

    BOOL wrote = WriteProcessMemory(hProcess, remoteMem, dllPath, sizeBytes, NULL);
    if (!wrote) {
        VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
        return FALSE;
    }

    HMODULE hKernel32 = GetModuleHandleW(L"kernel32.dll");
    LPTHREAD_START_ROUTINE loadLibraryAddr =
        (LPTHREAD_START_ROUTINE)GetProcAddress(hKernel32, "LoadLibraryW");

    HANDLE hThread =
        CreateRemoteThread(hProcess, NULL, 0, loadLibraryAddr, remoteMem, 0, NULL);
    if (!hThread) {
        VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
        return FALSE;
    }

    WaitForSingleObject(hThread, INFINITE);
    CloseHandle(hThread);
    VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
    return TRUE;
}

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, PWSTR pCmdLine,
                     int nCmdShow) {
    (void)hInstance;
    (void)hPrevInstance;
    (void)pCmdLine;
    (void)nCmdShow;

    wchar_t dir[MAX_PATH];
    GetSelfDir(dir, MAX_PATH);

    wchar_t gamePath[MAX_PATH];
    _snwprintf(gamePath, MAX_PATH, L"%s\\%s", dir, GAME_EXE);
    gamePath[MAX_PATH - 1] = L'\0';

    wchar_t dllPath[MAX_PATH];
    _snwprintf(dllPath, MAX_PATH, L"%s\\hook.dll", dir);
    dllPath[MAX_PATH - 1] = L'\0';

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);

    if (!CreateProcessW(gamePath, NULL, NULL, NULL, FALSE, CREATE_SUSPENDED, NULL, dir, &si,
                         &pi)) {
        MessageBoxW(NULL, L"Failed to launch the game executable", L"Patch Launcher",
                    MB_ICONERROR);
        return 1;
    }

    if (!InjectDll(pi.hProcess, dllPath)) {
        MessageBoxW(NULL, L"Failed to inject the patch DLL", L"Patch Launcher", MB_ICONERROR);
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return 1;
    }

    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}
