-- 올리기에 실패한 기록은 올린 사람이 지울 수 있게 (매니저 대리 업로드 포함)
drop policy if exists evaluations_delete on public.evaluations;
create policy evaluations_delete on public.evaluations for delete to authenticated using (
  (uploaded_by = (select auth.uid()) and status in ('uploading','failed'))
  or (employee_id = (select auth.uid()) and kind = 'practice' and status in ('practice','failed','uploading'))
);
