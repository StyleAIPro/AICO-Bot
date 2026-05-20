/**
 * Knowledge Base IPC Channel Constants
 */

// Knowledge Base CRUD
export const KB_LIST = 'knowledge-base:list';
export const KB_GET = 'knowledge-base:get';
export const KB_CREATE = 'knowledge-base:create';
export const KB_UPDATE = 'knowledge-base:update';
export const KB_DELETE = 'knowledge-base:delete';

// Source file management
export const KB_IMPORT_FILES = 'knowledge-base:import-files';
export const KB_IMPORT_FOLDER = 'knowledge-base:import-folder';
export const KB_REMOVE_SOURCE = 'knowledge-base:remove-source';
export const KB_LIST_SOURCES = 'knowledge-base:list-sources';

// Conversation precipitation
export const KB_SAVE_CONVERSATION = 'knowledge-base:save-conversation';
export const KB_LIST_CONVERSATIONS = 'knowledge-base:list-conversations';

// Wiki operations
export const KB_INGEST = 'knowledge-base:ingest';
export const KB_INGEST_ALL = 'knowledge-base:ingest-all';
export const KB_INGEST_INCREMENTAL = 'knowledge-base:ingest-incremental';
export const KB_INGEST_CANCEL = 'knowledge-base:ingest-cancel';
export const KB_RECOMPILE = 'knowledge-base:recompile';
export const KB_COMPILE = 'knowledge-base:compile';
export const KB_QUERY = 'knowledge-base:query';
export const KB_SAVE_QUERY = 'knowledge-base:save-query';
export const KB_LINT = 'knowledge-base:lint';
export const KB_GENERATE_REPORT = 'knowledge-base:generate-report';
export const KB_LOAD_REPORT = 'knowledge-base:load-report';
export const KB_AUDIT = 'knowledge-base:audit';

// Chat integration
export const KB_RETRIEVE = 'knowledge-base:retrieve';
export const KB_LIST_PAGES = 'knowledge-base:list-pages';
export const KB_READ_PAGE = 'knowledge-base:read-page';
export const KB_READ_SOURCE = 'knowledge-base:read-source';
export const KB_UPDATE_PAGE = 'knowledge-base:update-page';
export const KB_GET_PAGE_LINKS = 'knowledge-base:get-page-links';
export const KB_DELETE_PAGE = 'knowledge-base:delete-page';
export const KB_OPEN_SOURCE_BROWSER = 'knowledge-base:open-source-browser';
export const KB_OPEN_SOURCE_DEFAULT = 'knowledge-base:open-source-default';

// Knowledge graph
export const KB_GET_GRAPH = 'knowledge-base:get-graph-data';

// File selection
export const KB_SELECT_FILE = 'knowledge-base:select-file';
export const KB_SELECT_FOLDER = 'knowledge-base:select-folder';

// Events
export const KB_EVENT_INGEST_PROGRESS = 'knowledge-base:ingest-progress';
export const KB_EVENT_COMPILE_PROGRESS = 'knowledge-base:compile-progress';
