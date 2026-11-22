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

export async function signUpAction({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const name = String(form.get('name')).trim();
  const email = String(form.get('email'));
  const password = String(form.get('password'));

  if (!name) return { error: 'Enter your name' };

  try {
    await api('/auth/sign-up/email', {
      method: 'POST',
      body: { name, email, password },
    });
  } catch (error) {
    // Errors go back as data so the page reloads and keeps what was typed.
    if (!(error instanceof ApiError)) throw error;
    return {
      error:
        error.status === 422
          ? 'An account with this email already exists'
          : error.message,
    };
  }
  return redirect('/');
}

export function SignUp() {
  const result = useActionData<typeof signUpAction>();
  const submitting = useNavigation().state !== 'idle';
  const error = result && 'error' in result ? result.error : undefined;

  return (
    <Page>
      <h1 className="text-2xl font-semibold">Create an account</h1>
      <Form method="post" className="mt-6 space-y-4">
        <TextField label="Name" name="name" required autoComplete="name" />
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
          minLength={15}
          autoComplete="new-password"
          hint="At least 15 characters"
        />
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </Form>
      <p className="mt-6">
        <Link
          to="/sign-in"
          className={`rounded-control text-accent underline ${focusStyle}`}
        >
          Sign in instead
        </Link>
      </p>
    </Page>
  );
}
