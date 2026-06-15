// 配置（前端公开值；anon key 受数据库行级安全策略保护）
export const SUPABASE_URL = "https://vzrrlugpvbigqbhfuvss.supabase.co";
export const SUPABASE_KEY = "sb_publishable_b7baQespGjNqTWgSt_Bk1g_8ZvI6eMh";
export const BUCKET = "venue-photos";
// 双密码分权限（正式发布前可改更强的）
export const EDIT_PASSWORD = "takoedit";   // 编辑权限：能传照片、加备注、改内容
export const VIEW_PASSWORD = "takoview";   // 只读权限：只能看，不能改
