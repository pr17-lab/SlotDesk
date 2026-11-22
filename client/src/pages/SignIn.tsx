import {
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
} from 'react-router';
import type { ActionFunctionArgs } from 'react-router';
import { api, ApiError } from '../api';
import { Page } from '../Page';
import { Button, focusStyle, TextField } from '../ui';

export async function signInAction({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const email = String(form.get('email'));
  const password = String(form.get('password'));

  try {
    await api('/auth/sign-in/email', {
      method: 'POST',
      body: { email, password },
    });
  } catch (error) {
    // Errors go back as data so the page reloads and keeps what was typed.
    if (!(error instanceof ApiError)) throw error;
    return {
      error: error.status === 401 ? 'Wrong email or password' : error.message,
    };
  }
  return redirect('/');
}

export function SignIn() {
  const result = useActionData<typeof signInAction>();
  const submitting = useNavigation().state !== 'idle';
  const error = result && 'error' in result ? result.error : undefined;

  return (
    <Page>
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <Form method="post" className="mt-6 space-y-4">
        <TextField
          label="Email"
          name="email"
          type="email"
          required
          autoComplete="email"
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
        />
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </Form>
      <p className="mt-6">
        <Link
          to="/sign-up"
          className={`rounded-control text-accent underline ${focusStyle}`}
        >
          Create an account
        </Link>
      </p>
    </Page>
  );
}
