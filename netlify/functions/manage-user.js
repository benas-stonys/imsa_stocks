const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (error) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const action = body.action;
  if (!action) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing action' }) };
  }

  const { data: adminData, error: adminError } = await supabase.from('profiles').select('id').eq('role', 'admin');
  if (adminError) {
    return { statusCode: 500, body: JSON.stringify({ error: adminError.message }) };
  }

  const adminExists = (adminData || []).length > 0;
  let currentAdmin = null;

  if (action !== 'createAdmin' || adminExists) {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Missing authorization header' }) };
    }
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid auth token' }) };
    }
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', userData.user.id).single();
    if (!profile || profile.role !== 'admin') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
    }
    currentAdmin = profile;
  }

  try {
    if (action === 'createAdmin') {
      if (adminExists) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Admin account already exists' }) };
      }
      return await createAdmin(body);
    }

    if (action === 'createStudent') {
      return await createStudent(body);
    }

    if (action === 'resetPortfolio') {
      return await resetPortfolio(body);
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

async function createAdmin({ email, password, username }) {
  if (!email || !password || !username) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing admin user fields' }) };
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    user_metadata: { username, role: 'admin' },
  });

  if (error) {
    return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
  }

  const newUser = data.user;

  const { error: profileError } = await supabase.from('profiles').insert([{ id: newUser.id, username, role: 'admin', starting_cash: 10000 }]);
  if (profileError) {
    return { statusCode: 500, body: JSON.stringify({ error: profileError.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}

async function createStudent({ email, password, username, starting_cash }) {
  if (!email || !password || !username || !starting_cash) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing student fields' }) };
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    user_metadata: { username, role: 'student' },
  });

  if (error) {
    return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
  }

  const newUser = data.user;
  const cash = Number(starting_cash) || 10000;

  const { error: profileError } = await supabase.from('profiles').insert([{ id: newUser.id, username, role: 'student', starting_cash: cash }]);
  if (profileError) {
    return { statusCode: 500, body: JSON.stringify({ error: profileError.message }) };
  }

  const { error: portfolioError } = await supabase.from('portfolios').insert([{ student_id: newUser.id, cash, holdings: {} }]);
  if (portfolioError) {
    return { statusCode: 500, body: JSON.stringify({ error: portfolioError.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}

async function resetPortfolio({ student_id }) {
  if (!student_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing student_id' }) };
  }

  const { data: profile, error: profileError } = await supabase.from('profiles').select('*').eq('id', student_id).single();
  if (profileError || !profile) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Student profile not found' }) };
  }

  const cash = Number(profile.starting_cash) || 10000;
  const { error } = await supabase.from('portfolios').update({ cash, holdings: {}, updated_at: new Date().toISOString() }).eq('student_id', student_id);
  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}
