/* Explorer commands for the Windows 11 folder-background menu.
   Loaded by a packaged COM surrogate (dllhost), not by explorer.exe.
   Two classes: CLSID_GodmodeMenu is the "Open in terminal (godmode)" cascade, one CLI per
   item; CLSID_ModelPicker is one item that opens a console in the right-clicked folder
   and runs the model-picker launcher the app writes to %LOCALAPPDATA%\UsageMonitor\shell.

   Vtable slots below are the full slots, including IUnknown:
   IShellItem::GetDisplayName = 5, IShellItemArray::GetCount = 7,
   IShellItemArray::GetItemAt = 8, IServiceProvider::QueryService = 3,
   IShellBrowser::QueryActiveShellView = 15, IFolderView::GetFolder = 5.
   ECF_HASSUBCOMMANDS is 0x1. */
#include <windows.h>
#include <wchar.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>

/* TinyCC's windows.h does not declare the NLS or COM allocator calls. */
#define CP_UTF8 65001
#define MB_ERR_INVALID_CHARS 0x00000008
int WINAPI MultiByteToWideChar(UINT codePage, DWORD flags, const char *src, int srcLen, wchar_t *dst, int dstChars);
int WINAPI WideCharToMultiByte(UINT codePage, DWORD flags, const wchar_t *src, int srcChars, char *dst, int dstBytes, const char *def, int *usedDef);
void *WINAPI CoTaskMemAlloc(SIZE_T bytes);
void WINAPI CoTaskMemFree(void *pointer);

#define ECS_ENABLED 0
#define ECS_HIDDEN 0x2
#define ECF_HASSUBCOMMANDS 0x1
#define SIGDN_FILESYSPATH ((int)0x80058000)
#define MAX_CMDS 16
#define E_NOTIMPL_HR ((HRESULT)0x80004001)

static const GUID IID_IUnknown_ = { 0x00000000, 0x0000, 0x0000, { 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 } };
static const GUID IID_IClassFactory_ = { 0x00000001, 0x0000, 0x0000, { 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 } };
static const GUID IID_IExplorerCommand_ = { 0xA08CE4D0, 0xFA25, 0x44AB, { 0xB5, 0x7C, 0xC7, 0xB1, 0xC3, 0x23, 0xE0, 0xB9 } };
static const GUID IID_IEnumExplorerCommand_ = { 0xA88826F8, 0x186F, 0x4987, { 0xAA, 0xDE, 0xEA, 0x0C, 0xEF, 0x8F, 0xBF, 0xE8 } };
static const GUID IID_IObjectWithSite_ = { 0xFC4801A3, 0x2BA9, 0x11CF, { 0xA2, 0x29, 0x00, 0xAA, 0x00, 0x3D, 0x73, 0x52 } };
static const GUID IID_IServiceProvider_ = { 0x6D5140C1, 0x7436, 0x11CE, { 0x80, 0x34, 0x00, 0xAA, 0x00, 0x60, 0x09, 0xFA } };
static const GUID SID_STopLevelBrowser_ = { 0x4C96BE40, 0x915C, 0x11CF, { 0x99, 0xD3, 0x00, 0xAA, 0x00, 0x4A, 0xE8, 0x37 } };
static const GUID IID_IShellBrowser_ = { 0x000214E2, 0x0000, 0x0000, { 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 } };
static const GUID IID_IFolderView_ = { 0xCDE725B0, 0xCCC9, 0x4519, { 0x91, 0x7E, 0x32, 0x5D, 0x72, 0xFA, 0xB4, 0xCE } };
static const GUID IID_IShellItem_ = { 0x43826D1E, 0xE718, 0x42EE, { 0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE } };
static const GUID CLSID_GodmodeMenu = { 0x4C0E9B2A, 0x7F51, 0x4D63, { 0xA1, 0x8E, 0x6B, 0x5C, 0x3D, 0x9F, 0x27, 0x04 } };
static const GUID CLSID_ModelPicker = { 0x9A62378F, 0xB3ED, 0x482D, { 0x84, 0xD9, 0x3C, 0x5D, 0xA2, 0x94, 0xB6, 0xC0 } };

static const char *DEFAULTS[] = {
    "Claude Code\tclaude --dangerously-skip-permissions",
    "Codex\tcodex --dangerously-bypass-approvals-and-sandbox",
    "Grok Build\tgrok --always-approve",
    "Gemini\tagy --dangerously-skip-permissions",
    "Cursor\tcursor-agent --force",
};

typedef struct Entry {
    wchar_t label[96];
    wchar_t tail[240];
} Entry;

typedef struct Command Command;
typedef struct Enum Enum;

struct Command {
    void *lpVtbl;
    void *siteVtbl;
    LONG refs;
    int parent;
    int picker;
    int index;
    wchar_t label[96];
    wchar_t tail[240];
    void *site;
};

struct Enum {
    void *lpVtbl;
    LONG refs;
    Command *items[MAX_CMDS];
    int count;
    int index;
};

static LONG g_objects = 0;
static LONG g_locks = 0;

static int guid_eq(const GUID *a, const GUID *b) {
    return memcmp(a, b, sizeof(GUID)) == 0;
}

static HRESULT com_qi(void *obj, const GUID *iid, void **out) {
    void **vt;
    if (!out) return E_POINTER;
    *out = NULL;
    if (!obj) return E_POINTER;
    vt = *(void ***)obj;
    return ((HRESULT (STDMETHODCALLTYPE *)(void *, const GUID *, void **))vt[0])(obj, iid, out);
}

static ULONG com_addref(void *obj) {
    void **vt = *(void ***)obj;
    return ((ULONG (STDMETHODCALLTYPE *)(void *))vt[1])(obj);
}

static ULONG com_release(void *obj) {
    void **vt;
    if (!obj) return 0;
    vt = *(void ***)obj;
    return ((ULONG (STDMETHODCALLTYPE *)(void *))vt[2])(obj);
}

static HRESULT dup_wide(const wchar_t *src, wchar_t **out) {
    size_t bytes;
    wchar_t *copy;
    if (!out) return E_POINTER;
    *out = NULL;
    bytes = (wcslen(src) + 1) * sizeof(wchar_t);
    copy = (wchar_t *)CoTaskMemAlloc(bytes);
    if (!copy) return E_OUTOFMEMORY;
    memcpy(copy, src, bytes);
    *out = copy;
    return S_OK;
}

static int join2(wchar_t *out, int cap, const wchar_t *a, const wchar_t *b) {
    int n = 0;
    if (!a) a = L"";
    if (!b) b = L"";
    while (*a) {
        if (n + 1 >= cap) return 0;
        out[n++] = *a++;
    }
    while (*b) {
        if (n + 1 >= cap) return 0;
        out[n++] = *b++;
    }
    out[n] = 0;
    return 1;
}

static int shell_dir(wchar_t *out, int cap) {
    wchar_t local[520];
    DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", local, 520);
    if (n == 0 || n >= 520) return 0;
    if (!join2(out, cap, local, L"\\UsageMonitor\\shell")) return 0;
    return 1;
}

static void ensure_shell_dir(void) {
    wchar_t local[520];
    wchar_t parent[600];
    wchar_t dir[700];
    DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", local, 520);
    if (n == 0 || n >= 520) return;
    if (!join2(parent, 600, local, L"\\UsageMonitor")) return;
    CreateDirectoryW(parent, NULL);
    if (!join2(dir, 700, parent, L"\\shell")) return;
    CreateDirectoryW(dir, NULL);
}

static int append_text_char(char *dst, int cap, int pos, const char *src) {
    if (pos < 0 || !src) return -1;
    while (*src) {
        if (pos + 1 >= cap) return -1;
        dst[pos++] = *src++;
    }
    dst[pos] = 0;
    return pos;
}

static int append_uint(char *dst, int cap, int pos, unsigned value, int width) {
    char tmp[16];
    int n = 0;
    int i;
    if (pos < 0) return -1;
    do {
        if (n >= 16) return -1;
        tmp[n++] = (char)('0' + (value % 10));
        value /= 10;
    } while (value);
    while (n < width && n < 16) tmp[n++] = '0';
    if (pos + n >= cap) return -1;
    for (i = n - 1; i >= 0; i--) dst[pos++] = tmp[i];
    dst[pos] = 0;
    return pos;
}

static void log_line(const wchar_t *msg) {
    wchar_t dir[700];
    wchar_t path[800];
    char utf8[2400];
    char line[2600];
    SYSTEMTIME st;
    int pos = 0;
    int body;
    HANDLE file;
    DWORD wrote;
    DWORD size;
    if (!shell_dir(dir, 700)) return;
    if (!join2(path, 800, dir, L"\\godmode-menu.log")) return;
    ensure_shell_dir();
    GetLocalTime(&st);
    body = WideCharToMultiByte(CP_UTF8, 0, msg, -1, utf8, (int)sizeof(utf8) - 1, NULL, NULL);
    if (body <= 0) return;
    pos = append_uint(line, 2600, pos, st.wYear, 4);
    pos = append_text_char(line, 2600, pos, "-");
    pos = append_uint(line, 2600, pos, st.wMonth, 2);
    pos = append_text_char(line, 2600, pos, "-");
    pos = append_uint(line, 2600, pos, st.wDay, 2);
    pos = append_text_char(line, 2600, pos, " ");
    pos = append_uint(line, 2600, pos, st.wHour, 2);
    pos = append_text_char(line, 2600, pos, ":");
    pos = append_uint(line, 2600, pos, st.wMinute, 2);
    pos = append_text_char(line, 2600, pos, ":");
    pos = append_uint(line, 2600, pos, st.wSecond, 2);
    pos = append_text_char(line, 2600, pos, " ");
    pos = append_text_char(line, 2600, pos, utf8);
    pos = append_text_char(line, 2600, pos, "\r\n");
    if (pos <= 0) return;
    file = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return;
    size = GetFileSize(file, NULL);
    if (size != INVALID_FILE_SIZE && size > 65536) {
        SetFilePointer(file, 0, NULL, FILE_BEGIN);
        SetEndOfFile(file);
    }
    WriteFile(file, line, (DWORD)pos, &wrote, NULL);
    CloseHandle(file);
}

static int commands_file(wchar_t *out, int cap) {
    wchar_t dir[700];
    DWORD n = GetEnvironmentVariableW(L"USAGE_MONITOR_GODMODE_COMMANDS", out, (DWORD)cap);
    if (n > 0 && n < (DWORD)cap) return 1;
    if (!shell_dir(dir, 700)) return 0;
    return join2(out, cap, dir, L"\\godmode-commands.txt");
}

static int icon_file(wchar_t *out, int cap) {
    wchar_t dir[700];
    if (!shell_dir(dir, 700)) return 0;
    return join2(out, cap, dir, L"\\icon.ico");
}

static int launcher_file(wchar_t *out, int cap) {
    wchar_t dir[700];
    if (!shell_dir(dir, 700)) return 0;
    return join2(out, cap, dir, L"\\model-picker.cmd");
}

static int acceptable(const wchar_t *text, int spaces) {
    const wchar_t *p;
    if (!text || !text[0]) return 0;
    for (p = text; *p; p++) {
        wchar_t c = *p;
        if ((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9')) continue;
        if (c == L'-' || c == L'_' || c == L'.' || c == L':' || c == L'\\') continue;
        if (spaces && c == L' ') continue;
        return 0;
    }
    return 1;
}

static int widen_line(const char *bytes, int len, wchar_t *out, int cap) {
    int n;
    if (len <= 0 || cap < 2) return 0;
    n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes, len, out, cap - 1);
    if (n <= 0) return 0;
    out[n] = 0;
    return 1;
}

static int take_entry(const wchar_t *line, Entry *entry) {
    const wchar_t *tab = wcschr(line, L'\t');
    int labelLen;
    int tailLen;
    if (!tab) return 0;
    labelLen = (int)(tab - line);
    tailLen = (int)wcslen(tab + 1);
    if (labelLen <= 0 || labelLen >= 96 || tailLen <= 0 || tailLen >= 240) return 0;
    memcpy(entry->label, line, (size_t)labelLen * sizeof(wchar_t));
    entry->label[labelLen] = 0;
    memcpy(entry->tail, tab + 1, ((size_t)tailLen + 1) * sizeof(wchar_t));
    if (!acceptable(entry->label, 1) || !acceptable(entry->tail, 1)) return 0;
    return 1;
}

static int parse_utf8(const char *text, Entry *out, int max) {
    const char *p = text;
    int count = 0;
    if (p[0] == (char)0xEF && p[1] == (char)0xBB && p[2] == (char)0xBF) p += 3;
    while (*p && count < max) {
        const char *end = p;
        int len;
        wchar_t wide[400];
        while (*end && *end != '\n') end++;
        len = (int)(end - p);
        if (len > 0 && p[len - 1] == '\r') len--;
        if (len > 0 && p[0] != '#' && widen_line(p, len, wide, 400) && take_entry(wide, &out[count])) count++;
        p = *end == '\n' ? end + 1 : end;
    }
    return count;
}

static char *read_file(const wchar_t *path) {
    HANDLE file;
    DWORD size;
    DWORD read = 0;
    char *buf;
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return NULL;
    size = GetFileSize(file, NULL);
    if (size == INVALID_FILE_SIZE || size > 32768) {
        CloseHandle(file);
        return NULL;
    }
    buf = (char *)malloc((size_t)size + 1);
    if (!buf) {
        CloseHandle(file);
        return NULL;
    }
    if (!ReadFile(file, buf, size, &read, NULL)) {
        free(buf);
        CloseHandle(file);
        return NULL;
    }
    buf[read] = 0;
    CloseHandle(file);
    return buf;
}

static int load_entries(Entry *out, int max) {
    wchar_t path[800];
    char *text;
    int count = 0;
    int i;
    if (commands_file(path, 800)) {
        text = read_file(path);
        if (text) {
            count = parse_utf8(text, out, max);
            free(text);
        }
    }
    if (count > 0) return count;
    for (i = 0; i < 5 && count < max; i++) {
        if (parse_utf8(DEFAULTS[i], &out[count], 1) == 1) count++;
    }
    return count;
}

static int is_drive_root(const wchar_t *path) {
    return path && path[0] && path[1] == L':' && path[2] == L'\\' && path[3] == 0;
}

static int is_directory(const wchar_t *path) {
    DWORD attr = GetFileAttributesW(path);
    return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY);
}

static int normalize_dir(const wchar_t *in, wchar_t *out, int cap) {
    int i = 0;
    wchar_t *slash;
    if (!in || !in[0]) return 0;
    while (in[i] && i + 1 < cap) {
        out[i] = in[i];
        i++;
    }
    if (in[i]) return 0;
    out[i] = 0;
    while (i > 3 && (out[i - 1] == L'\\' || out[i - 1] == L'/')) out[--i] = 0;
    if (is_directory(out)) return 1;
    slash = wcsrchr(out, L'\\');
    if (!slash) return 0;
    if ((slash - out) == 2 && out[1] == L':') {
        out[3] = 0;
    } else {
        *slash = 0;
    }
    return is_directory(out);
}

static int append_text(wchar_t *dst, int cap, int pos, const wchar_t *src) {
    if (pos < 0 || !src) return -1;
    while (*src) {
        if (pos + 1 >= cap) return -1;
        dst[pos++] = *src++;
    }
    dst[pos] = 0;
    return pos;
}

static int append_quoted(wchar_t *dst, int cap, int pos, const wchar_t *src) {
    pos = append_text(dst, cap, pos, L"\"");
    if (pos < 0) return -1;
    for (; src && *src; src++) {
        if (*src == L'"') {
            pos = append_text(dst, cap, pos, L"\"");
            if (pos < 0) return -1;
        }
        if (pos + 1 >= cap) return -1;
        dst[pos++] = *src;
        dst[pos] = 0;
    }
    return append_text(dst, cap, pos, L"\"");
}

static int build_launch(const wchar_t *folder, const wchar_t *label, const wchar_t *tail, wchar_t *out, int cap) {
    wchar_t dir[1024];
    wchar_t token[1100];
    wchar_t title[140];
    wchar_t comspec[520];
    DWORD n;
    int pos;
    if (!normalize_dir(folder, dir, 1024)) return 0;
    if (!acceptable(tail, 1)) return 0;
    n = GetEnvironmentVariableW(L"ComSpec", comspec, 520);
    if (n == 0 || n >= 520) {
        lstrcpynW(comspec, L"C:\\Windows\\System32\\cmd.exe", 520);
    }
    if (!join2(title, 140, label, L" (godmode)")) return 0;
    if (is_drive_root(dir)) {
        token[0] = dir[0];
        token[1] = L':';
        token[2] = L'\\';
        token[3] = L'.';
        token[4] = 0;
    } else if (!join2(token, 1100, dir, L"")) {
        return 0;
    }
    pos = append_quoted(out, cap, 0, comspec);
    pos = append_text(out, cap, pos, L" /d /c start ");
    pos = append_quoted(out, cap, pos, title);
    pos = append_text(out, cap, pos, L" /D ");
    pos = append_quoted(out, cap, pos, token);
    pos = append_text(out, cap, pos, L" cmd.exe /d /k ");
    pos = append_text(out, cap, pos, tail);
    return pos > 0;
}

/* The picker console starts in the folder itself (CreateProcess current directory), so no
   folder text goes on the command line. /s strips only the outer pair of quotes, which
   keeps the launcher path quoted even when the profile path has spaces, & or (). */
static int build_picker_launch(wchar_t *out, int cap) {
    wchar_t comspec[520];
    wchar_t launcher[800];
    DWORD n;
    int pos;
    if (!launcher_file(launcher, 800)) return 0;
    n = GetEnvironmentVariableW(L"ComSpec", comspec, 520);
    if (n == 0 || n >= 520) {
        lstrcpynW(comspec, L"C:\\Windows\\System32\\cmd.exe", 520);
    }
    pos = append_quoted(out, cap, 0, comspec);
    pos = append_text(out, cap, pos, L" /d /s /k \"");
    pos = append_quoted(out, cap, pos, launcher);
    pos = append_text(out, cap, pos, L"\"");
    return pos > 0;
}

static HRESULT path_from_item(void *item, wchar_t *out, int cap) {
    void **vt;
    wchar_t *name = NULL;
    HRESULT hr;
    if (!item) return E_FAIL;
    vt = *(void ***)item;
    hr = ((HRESULT (STDMETHODCALLTYPE *)(void *, int, wchar_t **))vt[5])(item, SIGDN_FILESYSPATH, &name);
    if (FAILED(hr) || !name) return FAILED(hr) ? hr : E_FAIL;
    if (!normalize_dir(name, out, cap)) hr = E_FAIL;
    else hr = S_OK;
    CoTaskMemFree(name);
    return hr;
}

static HRESULT path_from_array(void *array, wchar_t *out, int cap) {
    void **vt;
    DWORD count = 0;
    void *item = NULL;
    HRESULT hr;
    if (!array) return E_FAIL;
    vt = *(void ***)array;
    hr = ((HRESULT (STDMETHODCALLTYPE *)(void *, DWORD *))vt[7])(array, &count);
    if (FAILED(hr) || count == 0) return E_FAIL;
    hr = ((HRESULT (STDMETHODCALLTYPE *)(void *, DWORD, void **))vt[8])(array, 0, &item);
    if (FAILED(hr) || !item) return E_FAIL;
    hr = path_from_item(item, out, cap);
    com_release(item);
    return hr;
}

static HRESULT path_from_site(void *site, wchar_t *out, int cap) {
    void *provider = NULL;
    void *browser = NULL;
    void *view = NULL;
    void *folder = NULL;
    void *item = NULL;
    HRESULT hr = E_FAIL;
    if (!site) goto done;
    hr = com_qi(site, &IID_IServiceProvider_, &provider);
    if (FAILED(hr) || !provider) goto done;
    hr = ((HRESULT (STDMETHODCALLTYPE *)(void *, const GUID *, const GUID *, void **))(*(void ***)provider)[3])(
        provider, &SID_STopLevelBrowser_, &IID_IShellBrowser_, &browser);
    if (FAILED(hr) || !browser) goto done;
    hr = ((HRESULT (STDMETHODCALLTYPE *)(void *, void **))(*(void ***)browser)[15])(browser, &view);
    if (FAILED(hr) || !view) goto done;
    hr = com_qi(view, &IID_IFolderView_, &folder);
    if (FAILED(hr) || !folder) goto done;
    hr = ((HRESULT (STDMETHODCALLTYPE *)(void *, const GUID *, void **))(*(void ***)folder)[5])(
        folder, &IID_IShellItem_, &item);
    if (FAILED(hr) || !item) goto done;
    hr = path_from_item(item, out, cap);
done:
    if (item) com_release(item);
    if (folder) com_release(folder);
    if (view) com_release(view);
    if (browser) com_release(browser);
    if (provider) com_release(provider);
    return hr;
}

static HRESULT resolve_folder(void *array, void *site, wchar_t *out, int cap) {
    if (SUCCEEDED(path_from_array(array, out, cap))) return S_OK;
    return path_from_site(site, out, cap);
}

static HRESULT cmd_query(Command *self, const GUID *iid, void **out);
static ULONG cmd_add(Command *self);
static ULONG cmd_release(Command *self);
static HRESULT cmd_title(Command *self, void *items, wchar_t **out);
static HRESULT cmd_icon(Command *self, void *items, wchar_t **out);
static HRESULT cmd_tip(Command *self, void *items, wchar_t **out);
static HRESULT cmd_name(Command *self, GUID *out);
static HRESULT cmd_state(Command *self, void *items, BOOL slow, DWORD *out);
static HRESULT cmd_invoke(Command *self, void *items, void *bind);
static HRESULT cmd_flags(Command *self, DWORD *out);
static HRESULT cmd_enum(Command *self, void **out);
static HRESULT site_query(void *self, const GUID *iid, void **out);
static ULONG site_add(void *self);
static ULONG site_release(void *self);
static HRESULT site_set(void *self, void *punk);
static HRESULT site_get(void *self, const GUID *iid, void **out);
static HRESULT enum_query(Enum *self, const GUID *iid, void **out);
static ULONG enum_add(Enum *self);
static ULONG enum_release(Enum *self);
static HRESULT enum_next(Enum *self, ULONG celt, void **commands, ULONG *fetched);
static HRESULT enum_skip(Enum *self, ULONG celt);
static HRESULT enum_reset(Enum *self);
static HRESULT enum_clone(Enum *self, void **out);

static const void *CMD_VTBL[] = {
    cmd_query, cmd_add, cmd_release, cmd_title, cmd_icon, cmd_tip, cmd_name, cmd_state, cmd_invoke, cmd_flags, cmd_enum,
};
static const void *SITE_VTBL[] = { site_query, site_add, site_release, site_set, site_get };
static const void *ENUM_VTBL[] = { enum_query, enum_add, enum_release, enum_next, enum_skip, enum_reset, enum_clone };

static Command *command_new(int parent, int index, const wchar_t *label, const wchar_t *tail, void *site) {
    Command *cmd = (Command *)calloc(1, sizeof(Command));
    if (!cmd) return NULL;
    cmd->lpVtbl = (void *)CMD_VTBL;
    cmd->siteVtbl = (void *)SITE_VTBL;
    cmd->refs = 1;
    cmd->parent = parent;
    cmd->index = index;
    if (label) lstrcpynW(cmd->label, label, 96);
    if (tail) lstrcpynW(cmd->tail, tail, 240);
    if (site) {
        cmd->site = site;
        com_addref(site);
    }
    InterlockedIncrement(&g_objects);
    return cmd;
}

static HRESULT cmd_query(Command *self, const GUID *iid, void **out) {
    if (!out) return E_POINTER;
    *out = NULL;
    if (!iid) return E_POINTER;
    if (guid_eq(iid, &IID_IUnknown_) || guid_eq(iid, &IID_IExplorerCommand_)) {
        *out = self;
    } else if (guid_eq(iid, &IID_IObjectWithSite_)) {
        *out = &self->siteVtbl;
    } else {
        return E_NOINTERFACE;
    }
    cmd_add(self);
    return S_OK;
}

static ULONG cmd_add(Command *self) {
    return (ULONG)InterlockedIncrement(&self->refs);
}

static ULONG cmd_release(Command *self) {
    LONG left = InterlockedDecrement(&self->refs);
    if (left == 0) {
        if (self->site) com_release(self->site);
        free(self);
        InterlockedDecrement(&g_objects);
    }
    return (ULONG)left;
}

static HRESULT cmd_title(Command *self, void *items, wchar_t **out) {
    (void)items;
    if (self->picker) return dup_wide(L"Open model picker here", out);
    if (self->parent) return dup_wide(L"Open in terminal (godmode)", out);
    return dup_wide(self->label, out);
}

static HRESULT cmd_icon(Command *self, void *items, wchar_t **out) {
    wchar_t path[800];
    (void)self;
    (void)items;
    if (!out) return E_POINTER;
    *out = NULL;
    if (!icon_file(path, 800)) return E_NOTIMPL_HR;
    if (GetFileAttributesW(path) == INVALID_FILE_ATTRIBUTES) return E_NOTIMPL_HR;
    return dup_wide(path, out);
}

static HRESULT cmd_tip(Command *self, void *items, wchar_t **out) {
    (void)self;
    (void)items;
    if (out) *out = NULL;
    return E_NOTIMPL_HR;
}

static HRESULT cmd_name(Command *self, GUID *out) {
    if (!out) return E_POINTER;
    if (self->picker) {
        *out = CLSID_ModelPicker;
        return S_OK;
    }
    *out = CLSID_GodmodeMenu;
    if (!self->parent) out->Data4[5] = (unsigned char)(self->index + 1);
    return S_OK;
}

static HRESULT cmd_state(Command *self, void *items, BOOL slow, DWORD *out) {
    Entry entries[MAX_CMDS];
    wchar_t launcher[800];
    (void)items;
    (void)slow;
    if (!out) return E_POINTER;
    if (self->picker) {
        *out = launcher_file(launcher, 800) && GetFileAttributesW(launcher) != INVALID_FILE_ATTRIBUTES ? ECS_ENABLED : ECS_HIDDEN;
        return S_OK;
    }
    if (!self->parent) {
        *out = ECS_ENABLED;
        return S_OK;
    }
    *out = load_entries(entries, MAX_CMDS) > 0 ? ECS_ENABLED : ECS_HIDDEN;
    return S_OK;
}

static int dry_run(void) {
    wchar_t value[8];
    DWORD n = GetEnvironmentVariableW(L"USAGE_MONITOR_GODMODE_DRY_RUN", value, 8);
    return n == 1 && value[0] == L'1';
}

static HRESULT cmd_invoke(Command *self, void *items, void *bind) {
    wchar_t folder[1024];
    wchar_t line[2048];
    wchar_t note[2200];
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    wchar_t *writable;
    BOOL ok;
    (void)bind;
    if (self->parent) return S_OK;
    if (FAILED(resolve_folder(items, self->site, folder, 1024))) {
        log_line(L"invoke failed: no folder");
        return E_FAIL;
    }
    if (self->picker ? !build_picker_launch(line, 2048) : !build_launch(folder, self->label, self->tail, line, 2048)) {
        log_line(L"invoke failed: command");
        return E_FAIL;
    }
    if (!join2(note, 2200, L"invoke ", line)) log_line(L"invoke");
    else log_line(note);
    if (dry_run()) return S_OK;
    writable = (wchar_t *)malloc((wcslen(line) + 1) * sizeof(wchar_t));
    if (!writable) return E_OUTOFMEMORY;
    memcpy(writable, line, (wcslen(line) + 1) * sizeof(wchar_t));
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    if (self->picker) si.lpTitle = L"Model picker";
    ZeroMemory(&pi, sizeof(pi));
    /* The godmode line starts its own console through start; the picker gets one here. */
    ok = CreateProcessW(NULL, writable, NULL, NULL, FALSE, self->picker ? CREATE_NEW_CONSOLE : CREATE_NO_WINDOW, NULL,
        self->picker ? folder : NULL, &si, &pi);
    free(writable);
    if (!ok) {
        char err[80];
        wchar_t wide[80];
        int pos = append_text_char(err, 80, 0, "invoke failed: CreateProcess ");
        pos = append_uint(err, 80, pos, GetLastError(), 0);
        if (pos > 0 && MultiByteToWideChar(CP_UTF8, 0, err, -1, wide, 80) > 0) log_line(wide);
        return E_FAIL;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return S_OK;
}

static HRESULT cmd_flags(Command *self, DWORD *out) {
    if (!out) return E_POINTER;
    *out = self->parent ? ECF_HASSUBCOMMANDS : 0;
    return S_OK;
}

static HRESULT cmd_enum(Command *self, void **out) {
    Entry entries[MAX_CMDS];
    Enum *list;
    int count;
    int i;
    if (!out) return E_POINTER;
    *out = NULL;
    if (!self->parent) return E_NOTIMPL_HR;
    count = load_entries(entries, MAX_CMDS);
    list = (Enum *)calloc(1, sizeof(Enum));
    if (!list) return E_OUTOFMEMORY;
    list->lpVtbl = (void *)ENUM_VTBL;
    list->refs = 1;
    list->count = 0;
    InterlockedIncrement(&g_objects);
    for (i = 0; i < count; i++) {
        Command *child = command_new(0, i, entries[i].label, entries[i].tail, self->site);
        if (!child) {
            enum_release(list);
            return E_OUTOFMEMORY;
        }
        list->items[list->count++] = child;
    }
    *out = list;
    return S_OK;
}

static HRESULT site_query(void *self, const GUID *iid, void **out) {
    Command *cmd = (Command *)((char *)self - offsetof(Command, siteVtbl));
    return cmd_query(cmd, iid, out);
}

static ULONG site_add(void *self) {
    Command *cmd = (Command *)((char *)self - offsetof(Command, siteVtbl));
    return cmd_add(cmd);
}

static ULONG site_release(void *self) {
    Command *cmd = (Command *)((char *)self - offsetof(Command, siteVtbl));
    return cmd_release(cmd);
}

static HRESULT site_set(void *self, void *punk) {
    Command *cmd = (Command *)((char *)self - offsetof(Command, siteVtbl));
    if (cmd->site) com_release(cmd->site);
    cmd->site = punk;
    if (punk) com_addref(punk);
    return S_OK;
}

static HRESULT site_get(void *self, const GUID *iid, void **out) {
    Command *cmd = (Command *)((char *)self - offsetof(Command, siteVtbl));
    if (!out) return E_POINTER;
    *out = NULL;
    if (!cmd->site) return E_FAIL;
    return com_qi(cmd->site, iid, out);
}

static HRESULT enum_query(Enum *self, const GUID *iid, void **out) {
    if (!out) return E_POINTER;
    *out = NULL;
    if (!iid) return E_POINTER;
    if (!guid_eq(iid, &IID_IUnknown_) && !guid_eq(iid, &IID_IEnumExplorerCommand_)) return E_NOINTERFACE;
    *out = self;
    enum_add(self);
    return S_OK;
}

static ULONG enum_add(Enum *self) {
    return (ULONG)InterlockedIncrement(&self->refs);
}

static ULONG enum_release(Enum *self) {
    LONG left = InterlockedDecrement(&self->refs);
    int i;
    if (left == 0) {
        for (i = 0; i < self->count; i++) {
            if (self->items[i]) cmd_release(self->items[i]);
        }
        free(self);
        InterlockedDecrement(&g_objects);
    }
    return (ULONG)left;
}

static HRESULT enum_next(Enum *self, ULONG celt, void **commands, ULONG *fetched) {
    ULONG n = 0;
    if (!commands && celt > 0) return E_POINTER;
    if (!fetched && celt != 1) return E_INVALIDARG;
    while (n < celt && self->index < self->count) {
        Command *cmd = self->items[self->index++];
        cmd_add(cmd);
        commands[n++] = cmd;
    }
    if (fetched) *fetched = n;
    return n == celt ? S_OK : S_FALSE;
}

static HRESULT enum_skip(Enum *self, ULONG celt) {
    if (self->index + (int)celt > self->count) {
        self->index = self->count;
        return S_FALSE;
    }
    self->index += (int)celt;
    return S_OK;
}

static HRESULT enum_reset(Enum *self) {
    self->index = 0;
    return S_OK;
}

static HRESULT enum_clone(Enum *self, void **out) {
    Enum *copy;
    int i;
    if (!out) return E_POINTER;
    *out = NULL;
    copy = (Enum *)calloc(1, sizeof(Enum));
    if (!copy) return E_OUTOFMEMORY;
    copy->lpVtbl = (void *)ENUM_VTBL;
    copy->refs = 1;
    copy->count = self->count;
    copy->index = self->index;
    for (i = 0; i < self->count; i++) {
        copy->items[i] = self->items[i];
        cmd_add(copy->items[i]);
    }
    InterlockedIncrement(&g_objects);
    *out = copy;
    return S_OK;
}

typedef struct Factory {
    void *lpVtbl;
    LONG refs;
    int picker;
} Factory;

static HRESULT factory_query(Factory *self, const GUID *iid, void **out);
static ULONG factory_add(Factory *self);
static ULONG factory_release(Factory *self);
static HRESULT factory_create(Factory *self, void *outer, const GUID *iid, void **out);
static HRESULT factory_lock(Factory *self, BOOL lock);

static const void *FACTORY_VTBL[] = { factory_query, factory_add, factory_release, factory_create, factory_lock };
static Factory g_factory = { (void *)FACTORY_VTBL, 1, 0 };
static Factory g_picker_factory = { (void *)FACTORY_VTBL, 1, 1 };

static HRESULT factory_query(Factory *self, const GUID *iid, void **out) {
    if (!out) return E_POINTER;
    *out = NULL;
    if (!iid) return E_POINTER;
    if (!guid_eq(iid, &IID_IUnknown_) && !guid_eq(iid, &IID_IClassFactory_)) return E_NOINTERFACE;
    *out = self;
    factory_add(self);
    return S_OK;
}

static ULONG factory_add(Factory *self) {
    return (ULONG)InterlockedIncrement(&self->refs);
}

static ULONG factory_release(Factory *self) {
    LONG left = InterlockedDecrement(&self->refs);
    if (left == 0) {
        self->refs = 1;
        return 1;
    }
    return (ULONG)left;
}

static HRESULT factory_create(Factory *self, void *outer, const GUID *iid, void **out) {
    Command *cmd;
    HRESULT hr;
    if (!out) return E_POINTER;
    *out = NULL;
    if (outer) return CLASS_E_NOAGGREGATION;
    cmd = command_new(self->picker ? 0 : 1, -1, NULL, NULL, NULL);
    if (!cmd) return E_OUTOFMEMORY;
    cmd->picker = self->picker;
    hr = cmd_query(cmd, iid, out);
    cmd_release(cmd);
    return hr;
}

static HRESULT factory_lock(Factory *self, BOOL lock) {
    (void)self;
    if (lock) InterlockedIncrement(&g_locks);
    else InterlockedDecrement(&g_locks);
    return S_OK;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void *reserved) {
    (void)instance;
    (void)reason;
    (void)reserved;
    return TRUE;
}

__declspec(dllexport) HRESULT WINAPI DllGetClassObject(const GUID *clsid, const GUID *iid, void **out) {
    if (!out) return E_POINTER;
    *out = NULL;
    if (!clsid) return CLASS_E_CLASSNOTAVAILABLE;
    if (guid_eq(clsid, &CLSID_GodmodeMenu)) return factory_query(&g_factory, iid, out);
    if (guid_eq(clsid, &CLSID_ModelPicker)) return factory_query(&g_picker_factory, iid, out);
    return CLASS_E_CLASSNOTAVAILABLE;
}

__declspec(dllexport) HRESULT WINAPI DllCanUnloadNow(void) {
    return (g_objects == 0 && g_locks == 0) ? S_OK : S_FALSE;
}
