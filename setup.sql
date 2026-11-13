-- =====================================================================
-- Angela Agunwami Onwuka website: database setup
-- Run this ONCE in Supabase: SQL Editor -> New query -> paste -> Run.
-- =====================================================================

-- ---------- Roles ----------
-- pending      : signed up, no access until a super admin approves
-- admin        : edits website content, photos, replies, subscribers
-- super_admin  : everything an admin can do, plus manages who has access

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  role        text not null default 'pending' check (role in ('pending','admin','super_admin')),
  created_at  timestamptz not null default now()
);

-- The current user's role (security definer avoids rule recursion).
create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;
grant execute on function public.my_role() to anon, authenticated;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','super_admin'), false)
$$;
grant execute on function public.is_staff() to anon, authenticated;

-- New sign-ups: the very first account becomes super admin, everyone after starts as pending.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email,
          case when not exists (select 1 from public.profiles) then 'super_admin' else 'pending' end);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- Never allow the last super admin to be removed or demoted.
create or replace function public.keep_one_super_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'super_admin'
     and (tg_op = 'DELETE' or new.role <> 'super_admin')
     and not exists (select 1 from public.profiles where role = 'super_admin' and id <> old.id) then
    raise exception 'There must always be at least one super admin.';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists keep_one_super_admin on public.profiles;
create trigger keep_one_super_admin
  before update or delete on public.profiles for each row execute function public.keep_one_super_admin();

alter table public.profiles enable row level security;
drop policy if exists "profiles: read own or super admin" on public.profiles;
create policy "profiles: read own or super admin" on public.profiles
  for select to authenticated using (id = auth.uid() or public.my_role() = 'super_admin');
drop policy if exists "profiles: super admin updates" on public.profiles;
create policy "profiles: super admin updates" on public.profiles
  for update to authenticated using (public.my_role() = 'super_admin') with check (public.my_role() = 'super_admin');
drop policy if exists "profiles: super admin deletes" on public.profiles;
create policy "profiles: super admin deletes" on public.profiles
  for delete to authenticated using (public.my_role() = 'super_admin');

-- ---------- Website content ----------
create table if not exists public.site_content (
  id          int primary key default 1 check (id = 1),
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null
);

alter table public.site_content enable row level security;
drop policy if exists "content: everyone reads" on public.site_content;
create policy "content: everyone reads" on public.site_content
  for select to anon, authenticated using (true);
drop policy if exists "content: staff edits" on public.site_content;
create policy "content: staff edits" on public.site_content
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- ---------- Replies to Thoughts ----------
create table if not exists public.replies (
  id          uuid primary key default gen_random_uuid(),
  thought_id  text not null check (char_length(thought_id) between 1 and 40),
  name        text not null check (char_length(name) between 1 and 60),
  body        text not null check (char_length(body) between 1 and 500),
  created_at  timestamptz not null default now()
);

alter table public.replies enable row level security;
drop policy if exists "replies: everyone reads" on public.replies;
create policy "replies: everyone reads" on public.replies
  for select to anon, authenticated using (true);
drop policy if exists "replies: anyone posts" on public.replies;
create policy "replies: anyone posts" on public.replies
  for insert to anon, authenticated with check (true);
drop policy if exists "replies: staff removes" on public.replies;
create policy "replies: staff removes" on public.replies
  for delete to authenticated using (public.is_staff());

-- ---------- Newsletter subscribers ----------
create table if not exists public.subscribers (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name        text check (char_length(name) <= 80),
  frequency   text not null default 'weekly' check (frequency in ('daily','weekly')),
  created_at  timestamptz not null default now()
);

alter table public.subscribers enable row level security;
drop policy if exists "subscribers: anyone joins" on public.subscribers;
create policy "subscribers: anyone joins" on public.subscribers
  for insert to anon, authenticated with check (true);
drop policy if exists "subscribers: staff reads" on public.subscribers;
create policy "subscribers: staff reads" on public.subscribers
  for select to authenticated using (public.is_staff());
drop policy if exists "subscribers: staff removes" on public.subscribers;
create policy "subscribers: staff removes" on public.subscribers
  for delete to authenticated using (public.is_staff());

-- ---------- Photo storage ----------
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do update set public = true;

drop policy if exists "media: staff uploads" on storage.objects;
create policy "media: staff uploads" on storage.objects
  for insert to authenticated with check (bucket_id = 'media' and public.is_staff());
drop policy if exists "media: staff updates" on storage.objects;
create policy "media: staff updates" on storage.objects
  for update to authenticated using (bucket_id = 'media' and public.is_staff());
drop policy if exists "media: staff deletes" on storage.objects;
create policy "media: staff deletes" on storage.objects
  for delete to authenticated using (bucket_id = 'media' and public.is_staff());

-- ---------- Starting content ----------
insert into public.site_content (id, data)
values (1, $seed$
{
 "profile": {
  "name": "Angela Agunwami *Onwuka*",
  "kicker": "Atlanta, Georgia · Rooted in Nigeria",
  "tagline": "Founder, technologist and content creator. I build businesses, explore artificial intelligence, and share the life in between.",
  "photo": "/images/portrait.jpg",
  "photoAlt": "Portrait of Angela Agunwami Onwuka"
 },
 "sections": {
  "about": true,
  "building": true,
  "interests": true,
  "gallery": true,
  "thoughts": true,
  "quote": true,
  "journal": true,
  "subscribe": true
 },
 "socials": [
  {
   "platform": "instagram",
   "handle": "@agunwamiii",
   "url": "https://www.instagram.com/agunwamiii"
  },
  {
   "platform": "tiktok",
   "handle": "@agunwamiii",
   "url": "https://www.tiktok.com/@agunwamiii"
  },
  {
   "platform": "x",
   "handle": "@agunwamiii",
   "url": "https://x.com/agunwamiii"
  }
 ],
 "about": {
  "heading": "Two homes, one long journey",
  "photo": "",
  "photoAlt": "",
  "lead": "I was born and raised in Nigeria and moved to the United States at thirteen. Both places shaped who I am, and both show up in everything I build.",
  "paragraphs": [
   "My background sits where technology and business meet. I've spent my career turning what people need into systems that work, and I'm always learning, lately with a focus on artificial intelligence.",
   "In 2022 I founded Agunwami Enterprises, where I lead a team building digital products for the US and Nigeria.",
   "Being a founder is a big part of my life, but it isn't all of it. This site is the rest: what I'm learning, what I'm making, and what I'm figuring out along the way."
  ],
  "facts": [
   {
    "label": "Based in",
    "value": "Atlanta, Georgia"
   },
   {
    "label": "Roots",
    "value": "Nigeria"
   },
   {
    "label": "Building",
    "value": "Agunwami Enterprises, founder & CEO"
   },
   {
    "label": "Creating",
    "value": "Lifestyle, tech and business content"
   }
  ]
 },
 "building": {
  "heading": "What I'm working on",
  "items": [
   {
    "name": "*Agunwami* Enterprises",
    "status": "Since 2022 · Founder & CEO",
    "description": "My company builds websites and software, from business sites to full platforms. I lead a hands-on team that works in sprints with clear ownership and honest reporting. If you have something you want built, I'd love to hear about it.",
    "link": "https://agunwamienterprise.com",
    "ctaText": "Start a project",
    "featured": true
   },
   {
    "name": "Meridian Crest Solutions",
    "status": "Recruitment & staffing",
    "description": "Connecting employers with qualified candidates through direct-hire recruitment.",
    "link": "https://meridiancrestsolution.com",
    "featured": false,
    "ctaText": ""
   },
   {
    "name": "AE Hub",
    "status": "In development",
    "description": "A career and professional development platform for students, staff and administrators.",
    "link": "",
    "featured": false,
    "ctaText": ""
   },
   {
    "name": "Trendora Stores",
    "status": "In development",
    "description": "Online retail built for shoppers in Nigeria.",
    "link": "",
    "featured": false,
    "ctaText": ""
   },
   {
    "name": "A4L Stores",
    "status": "Concept",
    "description": "A marketplace where independent sellers and buyers meet and trade directly.",
    "link": "",
    "featured": false,
    "ctaText": ""
   },
   {
    "name": "Letter Well",
    "status": "In development",
    "description": "More details coming soon.",
    "link": "",
    "featured": false,
    "ctaText": ""
   },
   {
    "name": "AE Writing Tool",
    "status": "In development",
    "description": "More details coming soon.",
    "link": "",
    "featured": false,
    "ctaText": ""
   }
  ]
 },
 "gallery": {
  "heading": "Moments",
  "items": [
   {
    "src": "/images/gallery-1.jpg",
    "caption": ""
   },
   {
    "src": "/images/gallery-2.jpg",
    "caption": ""
   },
   {
    "src": "/images/gallery-3.jpg",
    "caption": ""
   }
  ]
 },
 "thoughts": {
  "heading": "Quick thoughts",
  "items": [
   {
    "id": "t1",
    "text": "Welcome to my corner of the internet. This is where I'll share quick thoughts between posts. Say hi below.",
    "date": "2026-11-13",
    "xUrl": ""
   }
  ]
 },
 "interests": {
  "heading": "What keeps me curious",
  "items": [
   {
    "title": "Artificial intelligence",
    "text": "Language models, conversational systems, and how AI can actually help a business run."
   },
   {
    "title": "Cybersecurity",
    "text": "Currently learning identity and access management, risk and compliance, one certification at a time."
   },
   {
    "title": "Photography",
    "text": "Seeing people and places carefully. Some of it will end up here."
   },
   {
    "title": "Content creation",
    "text": "Lifestyle, tech and business: the process, not just the highlights."
   }
  ]
 },
 "quote": {
  "label": "This week",
  "text": "Build for where you come from and where you are. You don't have to choose.",
  "by": "Angela · Sample quote, replace with your own"
 },
 "journal": {
  "heading": "Notes on life and work",
  "posts": [
   {
    "title": "From Abia to Atlanta",
    "category": "Life",
    "date": "",
    "status": "soon",
    "excerpt": "Moving countries at thirteen, and what it taught me about starting over.",
    "body": ""
   },
   {
    "title": "Our investment year",
    "category": "Building",
    "date": "",
    "status": "soon",
    "excerpt": "What it's really like to spend a year building before the revenue comes.",
    "body": ""
   },
   {
    "title": "Learning AI while running a company",
    "category": "Tech",
    "date": "",
    "status": "soon",
    "excerpt": "How I make time to keep learning, and what I'm finding most useful.",
    "body": ""
   }
  ]
 },
 "subscribe": {
  "heading": "Get a little of this in your inbox",
  "text": "A quote, a thought, and what I'm working on. Pick how often you'd like to hear from me. No spam, and you can leave anytime.",
  "dailyNote": "A quote each morning",
  "weeklyNote": "Quote, updates and new posts",
  "url": ""
 }
}
$seed$::jsonb)
on conflict (id) do nothing;
