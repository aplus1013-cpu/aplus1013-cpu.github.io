-- RPC는 로그인한 사용자만 호출할 수 있게 (기본 PUBLIC 실행 권한 제거)
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;
