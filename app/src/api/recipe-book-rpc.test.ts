import { isMissingFunctionError, rpcRecipeBook } from './recipe-book-rpc';

const rows = [{ slot_id: 1 }];

describe('rpcRecipeBook', () => {
  it('uses v2 when it exists', async () => {
    const calls: string[] = [];
    const res = await rpcRecipeBook(async (fn) => {
      calls.push(fn);
      return { data: rows, error: null };
    });
    expect(calls).toEqual(['get_my_recipe_book_v2']);
    expect(res.data).toBe(rows);
  });

  it.each([
    [{ message: 'x', code: 'PGRST202' }],
    [{ message: 'x', status: 404 }],
    [{ message: 'Could not find the function public.get_my_recipe_book_v2 in the schema cache' }],
  ])('falls back to the original function when v2 is missing (%j)', async (error) => {
    const calls: string[] = [];
    const res = await rpcRecipeBook(async (fn) => {
      calls.push(fn);
      return fn.endsWith('_v2') ? { data: null, error } : { data: rows, error: null };
    });
    expect(calls).toEqual(['get_my_recipe_book_v2', 'get_my_recipe_book']);
    expect(res.data).toBe(rows);
  });

  it('does not fall back on other errors', async () => {
    const calls: string[] = [];
    const error = { message: 'Authentication required', code: 'P0001', status: 400 };
    const res = await rpcRecipeBook(async (fn) => {
      calls.push(fn);
      return { data: null, error };
    });
    expect(calls).toEqual(['get_my_recipe_book_v2']);
    expect(res.error).toBe(error);
    expect(isMissingFunctionError({ message: 'JWT expired', status: 401 })).toBe(false);
  });
});
