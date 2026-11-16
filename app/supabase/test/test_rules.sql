\set ON_ERROR_STOP on
insert into auth.users values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002'),('00000000-0000-0000-0000-000000000003'),('00000000-0000-0000-0000-000000000004'),('00000000-0000-0000-0000-000000000009');
insert into invite_codes(code, role) values ('TEST','resident'),('TESTMOD','moderator');
create function pg_temp.as_user(n int) returns void language sql as $$ select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000'||n, false) $$;
set role authenticated;
-- bad code
select pg_temp.as_user(1);
do $$ begin perform join_pilot('nope'); raise exception 'FAIL: bad code accepted'; exception when others then if sqlerrm not like '%bad_code%' then raise; end if; end $$;
-- not member cannot create
do $$ begin perform create_complaint('astana','pothole',null,null,'x','a',51.13,71.43,null); raise exception 'FAIL'; exception when others then if sqlerrm not like '%not_member%' then raise; end if; end $$;
select join_pilot('test');
select pg_temp.as_user(2); select join_pilot('TEST');
select pg_temp.as_user(3); select join_pilot('TEST');
select pg_temp.as_user(4); select join_pilot('TEST');
select pg_temp.as_user(9); select join_pilot('TESTMOD');
-- direct insert blocked
select pg_temp.as_user(1);
do $$ begin insert into complaints(author,cat,lat,lng) values (auth.uid(),'pothole',1,1); raise exception 'FAIL direct insert'; exception when insufficient_privilege then null; end $$;
-- pothole: collecting -> to_send after 2nd confirm
select create_complaint('astana','pothole',null,null,'яма','пр. Абая 1',51.13,71.43,null) as id1 \gset
select status, conf_count from complaints where id=:id1;
do $$ begin perform confirm_complaint(1); raise exception 'FAIL double'; exception when others then if sqlerrm not like '%already_voted%' then raise; end if; end $$;
select pg_temp.as_user(2); select confirm_complaint(:id1);
select status, conf_count from complaints where id=:id1;
-- manhole goes straight to to_send; other capped
select pg_temp.as_user(1);
select create_complaint('astana','manhole',null,null,'люк',null,51.14,71.44,null) as id2 \gset
select create_complaint('astana','other','Упало дерево',3,'',null,51.15,71.45,null) as id3 \gset
select id, status, effective_sev(c) from complaints c order by id;
-- ticket by author
select set_ticket(:id1,'eotinish','ЖТ-123');
select status, ticket_no, sent_at is not null from complaints where id=:id1;
-- fixed votes: too far rejected
select pg_temp.as_user(2);
do $$ begin perform vote_repair(1,'fixed',51.14,71.43); raise exception 'FAIL far'; exception when others then if sqlerrm not like '%too_far%' then raise; end if; end $$;
select vote_repair(:id1,'fixed',51.1305,71.4302);
select pg_temp.as_user(3); select vote_repair(:id1,'notfixed',51.13,71.43);
select pg_temp.as_user(4); select vote_repair(:id1,'notfixed',51.13,71.43);
select status, round, fixed_count from complaints where id=:id1;
-- new round: 3 fixed
select pg_temp.as_user(2); select vote_repair(:id1,'fixed',51.13,71.43);
select pg_temp.as_user(3); select vote_repair(:id1,'fixed',51.13,71.43);
select pg_temp.as_user(1); select vote_repair(:id1,'fixed',51.13,71.43);
select status, fixed_count from complaints where id=:id1;
-- reopen
select pg_temp.as_user(2);
do $$ begin perform vote_repair(1,'bad',51.13,71.43); raise exception 'FAIL bad without photo'; exception when others then if sqlerrm not like '%photo_required%' then raise; end if; end $$;
do $$ begin perform vote_repair(1,'bad',51.13,71.43,'00000000-0000-0000-0000-000000000004/x.jpg'); raise exception 'FAIL foreign photo'; exception when others then if sqlerrm not like '%photo_required%' then raise; end if; end $$;
select vote_repair(:id1,'bad',51.13,71.43,'00000000-0000-0000-0000-000000000002/bad.jpg');
select pg_temp.as_user(4); select vote_repair(:id1,'bad',51.13,71.43,'00000000-0000-0000-0000-000000000004/bad.jpg');
select status, reopen_count, ticket_no, bad_photo_path from complaints where id=:id1;
-- resident cannot moderate
do $$ begin perform mod_action(3,'hide','x'); raise exception 'FAIL'; exception when others then if sqlerrm not like '%forbidden%' then raise; end if; end $$;
-- moderator
select pg_temp.as_user(9);
select mod_action(:id3,'approve_custom','3');
select mod_action(:id2,'hide','спам');
select set_ticket(:id2,'ikomek','109-555'); select mod_action(:id2,'answered');
select id, status, hidden, effective_sev(c) from complaints c order by id;
-- resident cannot see hidden or others' votes / invite codes
select pg_temp.as_user(2);
select count(*) as visible_to_2 from complaints;
select count(*) as votes_visible_to_2 from votes;
do $$ begin perform 1 from invite_codes; raise exception 'FAIL codes visible'; exception when insufficient_privilege then null; end $$;
-- anon can read map
reset role; set role anon; select set_config('request.jwt.claim.sub','',false);
select count(*) as visible_to_anon from complaints;
do $$ begin perform confirm_complaint(1); raise exception 'FAIL anon'; exception when insufficient_privilege then null; end $$;
reset role;
\echo ALL TESTS PASSED
