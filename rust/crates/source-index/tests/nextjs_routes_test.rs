use contract_core::envelope::{verify_envelope_integrity, ArtifactKind, ArtifactPayload};
use contract_core::ir::ContractDirection;
use source_index::nextjs_routes::{
    is_nextjs_route_file, looks_like_nextjs_root, route_from_file_path, NextJsRouteExtractor,
};
use source_index::provider::ProviderKind;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn test_nextjs_route_from_file_path() {
    assert_eq!(
        route_from_file_path("app/api/users/route.ts").as_deref(),
        Some("/api/users")
    );
    assert_eq!(
        route_from_file_path("src/app/api/users/[id]/route.ts").as_deref(),
        Some("/api/users/:id")
    );
    assert_eq!(
        route_from_file_path("app/(marketing)/about/route.ts").as_deref(),
        Some("/about")
    );
    assert_eq!(
        route_from_file_path("src/app/api/posts/[...slug]/route.ts").as_deref(),
        Some("/api/posts/:slug*")
    );
    assert_eq!(
        route_from_file_path("app/api/items/[[...slug]]/route.ts").as_deref(),
        Some("/api/items/:slug*")
    );
    assert_eq!(route_from_file_path("app/route.ts").as_deref(), Some("/"));
    assert_eq!(route_from_file_path("src/components/Button.tsx"), None);
}

#[test]
fn test_nextjs_is_route_file() {
    assert!(is_nextjs_route_file("app/api/users/route.ts"));
    assert!(is_nextjs_route_file("src/app/api/items/[id]/route.js"));
    assert!(!is_nextjs_route_file("node_modules/next/dist/route.ts"));
    assert!(!is_nextjs_route_file("app/page.tsx"));
}

#[test]
fn nextjs_json_literal_shape_and_error_status_are_extracted() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-next-literal-{}", nanos));
    let route_dir = tmp_dir.join("app/api/items");
    fs::create_dir_all(&route_dir).unwrap();
    fs::write(
        route_dir.join("route.ts"),
        r#"
interface CreateItemDto {
    name: string;
}

export async function POST(request: Request) {
    const body: CreateItemDto = await request.json();
    return NextResponse.json({ error: 'missing' }, { status: 404 });
}
"#,
    )
    .unwrap();

    let extractor = NextJsRouteExtractor::new(tmp_dir.clone(), &tmp_dir).unwrap();
    let env = extractor
        .build_envelope("item-service", None, "HEAD")
        .unwrap();
    assert!(
        env.completeness.complete,
        "{:?}",
        env.completeness.unresolved_endpoints
    );

    match env.payload {
        ArtifactPayload::Backend(payload) => {
            let response = payload
                .endpoints
                .iter()
                .find(|endpoint| endpoint.identity.direction == ContractDirection::Response)
                .expect("response endpoint");
            assert_eq!(
                response.status_code_family,
                Some(contract_core::ir::StatusCodeFamily::Error4xx5xx)
            );
            match response.body.as_ref().expect("literal response body") {
                contract_core::ir::WireType::Object(object) => {
                    assert_eq!(object.properties[0].wire_name, "error");
                }
                other => panic!("expected object literal, got {other:?}"),
            }
            let request = payload
                .endpoints
                .iter()
                .find(|endpoint| endpoint.identity.direction == ContractDirection::Request)
                .expect("request endpoint");
            assert!(matches!(
                request.body.as_ref(),
                Some(contract_core::ir::WireType::Object(object))
                    if object.name.as_deref() == Some("CreateItemDto")
            ));
        }
        _ => panic!("Payload must be Backend"),
    }

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn test_nextjs_producer_extraction_full() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!("sajimora-next-test-{}", nanos));
    let route_dir = tmp_dir.join("src/app/api/users/[id]");
    fs::create_dir_all(&route_dir).unwrap();

    let route_content = r#"
export interface UserDto {
    id: string;
    name: string;
    email?: string;
}

export interface UpdateUserDto {
    name: string;
}

export async function GET(
    request: Request,
    context: { params: { id: string } }
): Promise<NextResponse<UserDto>> {
    return NextResponse.json({ id: context.params.id, name: "Alice" });
}

export async function PUT(
    request: Request,
    context: { params: { id: string } }
): Promise<NextResponse<UserDto>> {
    const body: UpdateUserDto = await request.json();
    return NextResponse.json({ id: context.params.id, name: body.name });
}

export async function DELETE(
    request: Request,
    context: { params: { id: string } }
): Promise<Response> {
    return new Response(null, { status: 204 });
}
"#;

    fs::write(route_dir.join("route.ts"), route_content).unwrap();

    assert!(looks_like_nextjs_root(&tmp_dir));
    assert_eq!(ProviderKind::detect_on_disk(&tmp_dir), ProviderKind::NextJs);

    let extractor = NextJsRouteExtractor::new(tmp_dir.clone(), &tmp_dir).unwrap();
    assert_eq!(extractor.endpoints_count(), 3);

    let env = extractor
        .build_envelope("user-service", Some("v1"), "HEAD")
        .unwrap();

    assert!(verify_envelope_integrity(&env).unwrap());
    assert_eq!(env.kind, ArtifactKind::BackendContract);
    assert_eq!(env.profile.framework_profile.as_deref(), Some("NEXTJS"));
    assert!(
        env.completeness.complete,
        "request.json() body and a 204 Response must resolve: {:?}",
        env.completeness.unresolved_endpoints
    );
    assert_eq!(env.completeness.blockers.len(), 0);

    match env.payload {
        ArtifactPayload::Backend(payload) => {
            // Endpoints: 3 Response + 3 Request (since path param :id exists for all 3) = 6 endpoints
            assert_eq!(payload.endpoints.len(), 6);

            let type_pool = payload.type_pool.expect("type_pool must be present");
            assert!(type_pool.contains_key("UserDto"));
            assert!(type_pool.contains_key("UpdateUserDto"));

            let get_res = payload
                .endpoints
                .iter()
                .find(|e| {
                    e.identity.http_method == "GET"
                        && e.identity.direction == ContractDirection::Response
                })
                .expect("GET response endpoint must exist");

            assert_eq!(get_res.identity.normalized_route.raw_path, "/api/users/:id");
            assert_eq!(get_res.path_parameters.len(), 1);
            assert_eq!(get_res.path_parameters[0].name, "id");
            assert!(get_res.body.is_some());

            let put_req = payload
                .endpoints
                .iter()
                .find(|e| {
                    e.identity.http_method == "PUT"
                        && e.identity.direction == ContractDirection::Request
                })
                .expect("PUT request endpoint must exist");

            assert_eq!(put_req.path_parameters.len(), 1);
            assert_eq!(put_req.path_parameters[0].name, "id");
            match put_req.body.as_ref() {
                Some(contract_core::ir::WireType::Ref(reference))
                    if reference.r#ref == "java:com.demo.UpdateUserDto"
                        || reference.r#ref == "UpdateUserDto" => {}
                Some(contract_core::ir::WireType::Object(object))
                    if object.name.as_deref() == Some("UpdateUserDto") => {}
                other => panic!("PUT body must come from request.json(), got {other:?}"),
            }
        }
        _ => panic!("Payload must be ArtifactPayload::Backend"),
    }

    let _ = fs::remove_dir_all(tmp_dir);
}
