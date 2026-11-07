package com.example.sample;

import com.fasterxml.jackson.annotation.JsonProperty;

public class SampleDto {
    private Long id;
    @JsonProperty("custom_name")
    private String name;
    private boolean active;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public boolean isActive() {
        return active;
    }

    public void setActive(boolean active) {
        this.active = active;
    }
}
