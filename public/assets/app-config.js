/* Deployment configuration. Fill these in from the Supabase dashboard:
   Project Settings -> API -> Project URL and anon/publishable key.
   The anon key is safe to expose in the browser: all data access is
   enforced server-side by Row Level Security. */
window.SMART_RETAIL_CONFIG = {
  supabaseUrl: 'https://eyhbdutwxovcjkvwceut.supabase.co',
  supabaseAnonKey: 'sb_publishable_Oqw3Fa1SMWPo8zPLFzXpAg_36LjWKVu',
  /* ERP staff log in with a plain username; it maps to
     <username>@staffEmailDomain behind the scenes. Must match the
     STAFF_EMAIL_DOMAIN environment variable on Vercel. */
  staffEmailDomain: 'staff.sellersmart.uz'
};
