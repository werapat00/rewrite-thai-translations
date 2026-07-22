#ifndef PATCH_CONFIG_H
#define PATCH_CONFIG_H

/* The original game executable, expected to sit next to launcher.exe/hook.dll. */
#define GAME_EXE L"SiglusEngine_SteamEN.exe"

/* Text forced onto the game window's title bar, replacing whatever the game sets. */
#define WINDOW_TITLE L"Rewrite - Thai Patch"

/* Font face forced onto every font the game creates, so Thai glyphs render correctly. */
#define FONT_NAME L"RewriteThai"

typedef struct {
    const wchar_t *from; /* bare file name the game asks for */
    const wchar_t *to;   /* path to serve instead, relative to this folder */
} FileMapping;

static const FileMapping FILE_MAPPINGS[] = {
    {L"SceneEN.pck", L"SceneEN.pck"},
    {L"GameexeEN.dat", L"GameexeEN.dat"},
};

#define FILE_MAPPINGS_COUNT (sizeof(FILE_MAPPINGS) / sizeof(FILE_MAPPINGS[0]))

#endif
