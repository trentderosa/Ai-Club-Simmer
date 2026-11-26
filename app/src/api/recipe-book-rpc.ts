/**
 * Reads the recipe book. New databases have get_my_recipe_book_v2 (path plus
 * Cook anything). A database that hasn't applied 20261118150000 doesn't, so we
 * fall back to the original path-only get_my_recipe_book. Only a "function
 * missing" error falls back; anything else surfaces.
 */
type RpcResult = { data: unknown; error: { message: string; code?: string; status?: number } | null };
type Rpc = (fn: string) => PromiseLike<RpcResult>;

export function isMissingFunctionError(e: { message?: string; code?: string; status?: number }): boolean {
  return e.code === 'PGRST202' || e.status === 404 || /could not find the function/i.test(e.message ?? '');
}

export async function rpcRecipeBook(rpc: Rpc): Promise<RpcResult> {
  const v2 = await rpc('get_my_recipe_book_v2');
  if (v2.error && isMissingFunctionError(v2.error)) return rpc('get_my_recipe_book');
  return v2;
}

/**
 * A PostgREST error caused by a column the database doesn't have yet:
 * 42703 (undefined_column, on select), PGRST204 (column missing from the
 * schema cache, on insert/upsert), or the matching message text.
 */
export function isMissingColumnError(e: { message?: string; code?: string }): boolean {
  return e.code === '42703' || e.code === 'PGRST204' || /column .*does not exist|could not find the '.*' column/i.test(e.message ?? '');
}
