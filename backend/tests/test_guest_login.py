from conftest import *  # noqa: F401,F403  (fixtures)


def whoami(client):
    return client.get("/ui/whoami").json()["username"]


def test_guest_login_counts_judges_and_resets(client):
    names = []
    for _ in range(3):
        assert client.post("/auth/guest", json={}).status_code == 200
        names.append(whoami(client))
    assert names == ["Judge1", "Judge2", "Judge3"]

    assert client.post("/auth/guest/reset").status_code == 204
    client.post("/auth/guest", json={})
    assert whoami(client) == "Judge1"
    client.post("/auth/guest", json={})
    assert whoami(client) == "Judge2"
