/* Explorer command for the Windows 11 folder-background menu.
   Loaded by a packaged COM surrogate (dllhost), not by explorer.exe.
   One item, no submenu: it opens a console in the right-clicked folder and runs the
   model-picker launcher the app writes to %LOCALAPPDATA%\UsageMonitor\shell.

   Vtable slots below are the full slots, including IUnknown:
   IShellItem::GetDisplayName = 5, IShellItemArray::GetCount = 7,
   IShellItemArray::GetItemAt = 8, IServiceProvider::QueryService = 3,
   IShellBrowser::QueryActiveShellView = 15, IFolderView::GetFolder = 5. */
#include <windows.h>
#include <wchar.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>

/* TinyCC's windows.h does not declare the NLS or COM allocator calls. */
#define CP_UTF8 65001
int WINAPI MultiByteToWideChar(UINT codePage, DWORD flags, const char *src, int srcLen, wchar_t *dst, int dstChars);
int WINAPI WideCharToMultiByte(UINT codePage, DWORD flags, const wchar_t *src, int srcChars, char *dst, int dstBytes, const char *def, int *usedDef);
void *WINAPI CoTaskMemAlloc(SIZE_T bytes);
void WINAPI CoTaskMemFree(void *pointer);

#define ECS_ENABLED 0
#define ECS_HIDDEN 0x2
#define SIGDN_FILESYSPATH ((int)0x80058000)
#define E_NOTIMPL_HR ((HRESULT)0x80004001)

static const GUID IID_IUnknown_ = { 0x00000000, 0x0000, 0x0000, { 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 } };
static const GUID IID_IClassFactory_ = { 0x00000001, 0x0000, 0x0000, { 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 } };
static const GUID IID_IExplorerCommand_ = { 0xA08CE4D0, 0xFA25, 0x44AB, { 0xB5, 0x7C, 0xC7, 0xB1, 0xC3, 0x23, 0xE0, 0xB9 } };
static const GUID IID_IObjectWithSite_ = { 0xFC4801A3, 0x2BA9, 0x11CF, { 0xA2, 0x29, 0x00, 0xAA, 0x00, 0x3D, 0x73, 0x52 } };
static const GUID IID_IServiceProvider_ = { 0x6D5140C1, 0x7436, 0x11CE, { 0x80, 0x34, 0x00, 0xAA, 0x00, 0x60, 0x09, 0xFA } };
static const GUID SID_STopLevelBrowser_ = { 0x4C96BE40, 0x915C, 0x11CF, { 0x99, 0xD3, 0x00, 0xAA, 0x00, 0x4A, 0xE8, 0x37 } };
static const GUID IID_IShellBrowser_ = { 0x000214E2, 0x0000, 0x0000, { 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 } };
static const GUID IID_IFolderView_ = { 0xCDE725B0, 0xCCC9, 0x4519, { 0x91, 0x7E, 0x32, 0x5D, 0x72, 0xFA, 0xB4, 0xCE } };
static const GUID IID_IShellItem_ = { 0x43826D1E, 0xE718, 0x42EE, { 0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE } };
static const GUID CLSID_GodmodeMenu = { 0x4C0E9B2A, 0x7F51, 0x4D63, { 0xA1, 0x8E, 0x6B, 0x5C, 0x3D, 0x9F, 0x27, 0x04 } };

typedef struct Command Command;

struct Command {
    void *lpVtbl;
    void *siteVtbl;
    LONG refs;
    void *site;
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

static int launcher_file(wchar_t *out, int cap) {
    wchar_t dir[700];
    if (!shell_dir(dir, 700)) return 0;
    return join2(out, cap, dir, L"\\model-picker.cmd");
}

static int icon_file(wchar_t *out, int cap) {
    wchar_t dir[700];
    if (!shell_dir(dir, 700)) return 0;
    return join2(out, cap, dir, L"\\icon.ico");
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

/* The console starts in the folder itself (CreateProcess current directory), so no
   folder text goes on the command line. /s strips only the outer pair of quotes, which
   keeps the launcher path quoted even when the profile path has spaces, & or (). */
static int build_launch(wchar_t *out, int cap) {
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

static const void *CMD_VTBL[] = {
    cmd_query, cmd_add, cmd_release, cmd_title, cmd_icon, cmd_tip, cmd_name, cmd_state, cmd_invoke, cmd_flags, cmd_enum,
};
static const void *SITE_VTBL[] = { site_query, site_add, site_release, site_set, site_get };

static Command *command_new(void) {
    Command *cmd = (Command *)calloc(1, sizeof(Command));
    if (!cmd) return NULL;
    cmd->lpVtbl = (void *)CMD_VTBL;
    cmd->siteVtbl = (void *)SITE_VTBL;
    cmd->refs = 1;
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
    (void)self;
    (void)items;
    return dup_wide(L"Open model picker here", out);
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
    (void)self;
    if (!out) return E_POINTER;
    *out = CLSID_GodmodeMenu;
    return S_OK;
}

/* Hidden until the app has written the launcher, so the item never opens an empty console. */
static HRESULT cmd_state(Command *self, void *items, BOOL slow, DWORD *out) {
    wchar_t launcher[800];
    (void)self;
    (void)items;
    (void)slow;
    if (!out) return E_POINTER;
    *out = launcher_file(launcher, 800) && GetFileAttributesW(launcher) != INVALID_FILE_ATTRIBUTES ? ECS_ENABLED : ECS_HIDDEN;
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
    if (FAILED(resolve_folder(items, self->site, folder, 1024))) {
        log_line(L"invoke failed: no folder");
        return E_FAIL;
    }
    if (!build_launch(line, 2048)) {
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
    si.lpTitle = L"Model picker";
    ZeroMemory(&pi, sizeof(pi));
    ok = CreateProcessW(NULL, writable, NULL, NULL, FALSE, CREATE_NEW_CONSOLE, NULL, folder, &si, &pi);
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
    (void)self;
    if (!out) return E_POINTER;
    *out = 0;
    return S_OK;
}

static HRESULT cmd_enum(Command *self, void **out) {
    (void)self;
    if (!out) return E_POINTER;
    *out = NULL;
    return E_NOTIMPL_HR;
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

typedef struct Factory {
    void *lpVtbl;
    LONG refs;
} Factory;

static HRESULT factory_query(Factory *self, const GUID *iid, void **out);
static ULONG factory_add(Factory *self);
static ULONG factory_release(Factory *self);
static HRESULT factory_create(Factory *self, void *outer, const GUID *iid, void **out);
static HRESULT factory_lock(Factory *self, BOOL lock);

static const void *FACTORY_VTBL[] = { factory_query, factory_add, factory_release, factory_create, factory_lock };
static Factory g_factory = { (void *)FACTORY_VTBL, 1 };

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
    (void)self;
    if (!out) return E_POINTER;
    *out = NULL;
    if (outer) return CLASS_E_NOAGGREGATION;
    cmd = command_new();
    if (!cmd) return E_OUTOFMEMORY;
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
    if (!clsid || !guid_eq(clsid, &CLSID_GodmodeMenu)) return CLASS_E_CLASSNOTAVAILABLE;
    return factory_query(&g_factory, iid, out);
}

__declspec(dllexport) HRESULT WINAPI DllCanUnloadNow(void) {
    return (g_objects == 0 && g_locks == 0) ? S_OK : S_FALSE;
}
