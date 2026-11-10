use contract_core::ir::WireType;
use source_index::ts_routes::TypeScriptRouteExtractor;
use std::fs;
use tempfile::tempdir;

fn write_file(repo: &std::path::Path, rel: &str, content: &str) {
    let path = repo.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn extract(source: &str) -> contract_core::envelope::FrontendContractPayload {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    write_file(repo, "src/client.tsx", source);
    let extractor = TypeScriptRouteExtractor::new(repo.to_path_buf(), &repo.join("src")).unwrap();
    let (payload, _) = extractor.extract_payload("ui", "backend");
    payload
}

#[test]
fn test_react_query_use_query_with_axios() {
    let payload = extract(
        r#"
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';

interface User {
    id: string;
    name: string;
}

export function UserList() {
    const { data } = useQuery({
        queryKey: ['users'],
        queryFn: () => axios.get<User[]>('/api/users'),
    });
    return null;
}
"#,
    );
    assert_eq!(payload.client_contracts.len(), 1);
    let c = &payload.client_contracts[0];
    assert_eq!(c.http_method, "GET");
    assert_eq!(c.normalized_route, "/api/users");
    assert!(
        matches!(&c.expected_response, WireType::Array(arr) if matches!(arr.element_type.as_ref(), WireType::Ref(r) if r.r#ref.ends_with("#User"))),
        "expected Array<User>, got {:?}",
        c.expected_response
    );
}

#[test]
fn test_react_query_inline_fetch_and_v3_positional() {
    let payload = extract(
        r#"
import { useQuery } from '@tanstack/react-query';

export function UserList() {
    // React Query v5 object syntax with inline fetch
    const queryV5 = useQuery({
        queryKey: ['users'],
        queryFn: () => fetch('/api/v5/users').then(r => r.json()),
    });

    // React Query v3/v4 positional arguments syntax
    const queryV3 = useQuery(
        ['legacy-users'],
        () => fetch('/api/v3/users').then(r => r.json())
    );

    return null;
}
"#,
    );
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/v3/users".to_string()),
            ("GET".to_string(), "/api/v5/users".to_string()),
        ]
    );
}

#[test]
fn test_react_query_use_mutation_with_axios() {
    let payload = extract(
        r#"
import { useMutation } from '@tanstack/react-query';
import axios from 'axios';

interface CreateUserDto {
    name: string;
    email: string;
}

interface User {
    id: string;
    name: string;
}

export function CreateUserForm() {
    const mutation = useMutation({
        mutationFn: (newUser: CreateUserDto) => axios.post<User>('/api/users', newUser),
    });
    return null;
}
"#,
    );
    assert_eq!(payload.client_contracts.len(), 1);
    let c = &payload.client_contracts[0];
    assert_eq!(c.http_method, "POST");
    assert_eq!(c.normalized_route, "/api/users");
    assert!(
        matches!(&c.expected_response, WireType::Ref(r) if r.r#ref.ends_with("#User")),
        "expected User, got {:?}",
        c.expected_response
    );
}

#[test]
fn test_react_query_use_suspense_query_and_infinite_query() {
    let payload = extract(
        r#"
import { useSuspenseQuery, useInfiniteQuery } from '@tanstack/react-query';
import axios from 'axios';

interface Session {
    userId: string;
}

interface Item {
    id: number;
}

export function Dashboard() {
    const { data: session } = useSuspenseQuery({
        queryKey: ['session'],
        queryFn: () => axios.get<Session>('/api/session'),
    });

    const { data: items } = useInfiniteQuery({
        queryKey: ['items'],
        queryFn: ({ pageParam }) => axios.get<Item[]>(`/api/items?page=${pageParam}`),
        initialPageParam: 1,
        getNextPageParam: (last) => 2,
    });

    return null;
}
"#,
    );
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/items".to_string()),
            ("GET".to_string(), "/api/session".to_string()),
        ]
    );
}

#[test]
fn test_swr_and_swr_immutable() {
    let payload = extract(
        r#"
import useSWR from 'swr';
import useSWRImmutable from 'swr/immutable';
import useSWRMutation from 'swr/mutation';

interface UserProfile {
    id: string;
    name: string;
}

interface AppConfig {
    version: string;
}

async function sendMutation(url: string, { arg }: { arg: any }) {
    return fetch(url, { method: 'POST', body: JSON.stringify(arg) });
}

export function ProfileView() {
    const { data: profile } = useSWR<UserProfile>('/api/profile');
    const { data: config } = useSWRImmutable<AppConfig>('/api/config');
    const { trigger } = useSWRMutation('/api/profile/update', sendMutation);
    return null;
}
"#,
    );
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/config".to_string()),
            ("GET".to_string(), "/api/profile".to_string()),
            ("POST".to_string(), "/api/profile/update".to_string()),
        ]
    );
    let profile_contract = payload
        .client_contracts
        .iter()
        .find(|c| c.normalized_route == "/api/profile")
        .unwrap();
    assert!(
        matches!(&profile_contract.expected_response, WireType::Ref(r) if r.r#ref.ends_with("#UserProfile")),
        "expected UserProfile, got {:?}",
        profile_contract.expected_response
    );
}

#[test]
fn test_use_effect_and_use_callback_closures() {
    let payload = extract(
        r#"
import { useEffect, useCallback, useState } from 'react';
import axios from 'axios';

interface Stats {
    total: number;
}

export function Monitor() {
    const [stats, setStats] = useState<Stats | null>(null);

    useEffect(() => {
        fetch('/api/stats')
            .then(res => res.json())
            .then(data => setStats(data));
    }, []);

    const handleRefresh = useCallback(() => {
        axios.post('/api/refresh', { timestamp: Date.now() });
    }, []);

    return null;
}
"#,
    );
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec![
            ("GET".to_string(), "/api/stats".to_string()),
            ("POST".to_string(), "/api/refresh".to_string()),
        ]
    );
}

#[test]
fn test_nextjs_server_components_and_actions() {
    let payload = extract(
        r#"
interface Product {
    id: string;
    title: string;
}

export default async function ProductsPage() {
    const res = await fetch('https://api.example.com/api/products', {
        headers: { 'Content-Type': 'application/json' },
    });
    const products: Product[] = await res.json();
    return null;
}

export async function deleteProductAction(id: string) {
    'use server';
    await fetch(`/api/products/${id}`, {
        method: 'DELETE',
    });
}
"#,
    );
    let mut routes: Vec<(String, String)> = payload
        .client_contracts
        .iter()
        .map(|c| (c.http_method.clone(), c.normalized_route.clone()))
        .collect();
    routes.sort();
    assert_eq!(
        routes,
        vec![
            ("DELETE".to_string(), "/api/products/:param".to_string()),
            ("GET".to_string(), "/api/products".to_string()),
        ]
    );
}
